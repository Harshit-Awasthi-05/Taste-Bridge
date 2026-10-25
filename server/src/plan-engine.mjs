import { randomUUID } from "node:crypto";
import { callQlooTool, ENTITY_TYPES_BY_CATEGORY } from "./qloo-client.mjs";
import { DEMO_MEMBERS } from "./demo-members.mjs";

const OFFLINE_CANDIDATES = Object.freeze([
  {
    id: "demo-kamonegi",
    category: "dining",
    name: "Kamonegi",
    subtitle: "Handmade soba and tempura in a cozy Fremont setting",
    tags: ["japanese cuisine", "handmade noodles", "cozy dining"],
  },
  {
    id: "demo-men-i-trust",
    category: "music",
    name: "Men I Trust",
    subtitle: "Dreamy indie pop with a warm, groove-led sound",
    tags: ["indie pop", "dream pop", "instrumental grooves"],
  },
  {
    id: "demo-spider-verse",
    category: "film_tv",
    name: "Spider-Man: Into the Spider-Verse",
    subtitle: "A kinetic animated sci-fi film for a group movie night",
    tags: ["animation", "science fiction"],
  },
]);

const CATEGORY_LABELS = Object.freeze({
  dining: "Dinner",
  music: "Music",
  film_tv: "Movie night",
});
const DEMO_CITY = "Seattle";

function normalized(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function interestsFor(member, category) {
  return member.favorites.filter(
    (item) => item.category === category && typeof item.name === "string",
  );
}

function signalsFor(member, category, kind) {
  return interestsFor(member, category)
    .filter((item) => item.kind === kind)
    .map((item) => (kind === "entity" ? item.qlooId || item.name : item.name))
    .filter(Boolean)
    .slice(0, 10);
}

function optionFromQlooResult(result, category, memberId) {
  const option = result.entity && typeof result.entity === "object"
    ? result.entity
    : result;
  const id =
    option.entity_id ?? option.entityId ?? option.qloo_id ?? option.id;
  const name = option.name ?? option.title ?? option.label;
  if (typeof name !== "string" || name.trim().length === 0) {
    return null;
  }

  const stableId =
    typeof id === "string" && id.length > 0
      ? id
      : `${category}:${normalized(name)}`;
  return {
    id: `${category}:${stableId}`,
    qlooId: typeof id === "string" ? id : null,
    category,
    name: name.trim(),
    subtitle:
      option.short_description ??
      option.description ??
      option.properties?.short_description ??
      "",
    memberIds: [memberId],
    source: "qloo",
  };
}

function mergeOption(optionsById, option) {
  const existing = optionsById.get(option.id);
  if (existing) {
    if (!existing.memberIds.includes(option.memberIds[0])) {
      existing.memberIds.push(option.memberIds[0]);
    }
    if (!existing.subtitle && option.subtitle) {
      existing.subtitle = option.subtitle;
    }
    return existing;
  }
  optionsById.set(option.id, option);
  return option;
}

function addScoresAndReasons(option, members) {
  const memberNames = new Map(members.map((member) => [member.id, member.nickname]));
  const supporters = new Set(option.memberIds);
  option.supportCount = supporters.size;
  option.memberCount = members.length;
  option.overlapScore = Math.round((supporters.size / members.length) * 100);
  option.scoreLabel = "Qloo member coverage";
  option.reasonsByMember = Object.fromEntries(
    members.map((member) => {
      const categoryFavorites = interestsFor(member, option.category);
      const anchor =
        categoryFavorites.find((item) => item.kind === "entity") ??
        categoryFavorites[0];
      const reason = supporters.has(member.id)
        ? `Qloo included this in ${member.nickname}'s recommendations from ${anchor?.name ?? "their confirmed taste signals"}.`
        : `Qloo did not return this in ${member.nickname}'s top results; confirm this pick with them.`;
      return [member.id, reason];
    }),
  );
  option.memberNames = [...supporters].map(
    (memberId) => memberNames.get(memberId) ?? memberId,
  );
  return option;
}

function qlooRecommendationArgs(member, category) {
  const tags = signalsFor(member, category, "tag");
  const entities = signalsFor(member, category, "entity");
  const args = {
    target_type: ENTITY_TYPES_BY_CATEGORY[category],
    limit: 10,
    explain: true,
  };
  if (category === "dining") {
    args.filter_location = DEMO_CITY;
  }
  if (entities.length) {
    args.signals = entities;
  }
  if (tags.length) {
    args.signal_tags = tags;
    args.signal_tags_operator = "union";
  }
  if (!args.signals?.length && !args.signal_tags?.length) {
    return null;
  }
  return args;
}

async function loadQlooOptions(client, members) {
  const optionsByCategory = Object.fromEntries(
    Object.keys(ENTITY_TYPES_BY_CATEGORY).map((category) => [
      category,
      new Map(),
    ]),
  );
  const errors = [];
  let attempted = false;
  let stopAfterAuthenticationFailure = false;

  for (const category of Object.keys(ENTITY_TYPES_BY_CATEGORY)) {
    if (stopAfterAuthenticationFailure) {
      break;
    }
    for (const member of members) {
      if (stopAfterAuthenticationFailure) {
        break;
      }
      const args = qlooRecommendationArgs(member, category);
      if (!args) {
        continue;
      }
      attempted = true;
      try {
        const envelope = await callQlooTool(client, "qloo_recommend", args);
        if (!Array.isArray(envelope.results)) {
          throw new Error("Qloo recommendation response had no results array");
        }
        for (const result of envelope.results) {
          const option = optionFromQlooResult(result, category, member.id);
          if (option) {
            mergeOption(optionsByCategory[category], option);
          }
        }
      } catch (error) {
        errors.push(`${member.nickname} / ${category}: ${error.message}`);
        if (/QLOO_AUTH|HTTP 401/.test(error.message)) {
          stopAfterAuthenticationFailure = true;
        }
      }
    }
  }

  const options = Object.fromEntries(
    Object.entries(optionsByCategory).map(([category, optionMap]) => [
      category,
      [...optionMap.values()].map((option) => addScoresAndReasons(option, members)),
    ]),
  );

  return { options, errors, attempted };
}

function scoreOfflineCandidate(candidate, members) {
  const tags = new Set(candidate.tags.map(normalized));
  const matches = members.map((member) => {
    const profile = interestsFor(member, candidate.category);
    const matched = profile
      .filter((favorite) => tags.has(normalized(favorite.name)))
      .map((favorite) => favorite.name);
    return { member, matched };
  });
  const supporters = matches.filter((match) => match.matched.length > 0);
  const overlapScore = Math.round((supporters.length / members.length) * 100);
  const reasonsByMember = Object.fromEntries(
    matches.map(({ member, matched }) => [
      member.id,
      matched.length
        ? `You and the group both like ${matched.slice(0, 2).join(" and ")}; this pick connects those tastes.`
        : `This is the group's leading shared-interest pick; check whether ${member.nickname} is up for it.`,
    ]),
  );

  return {
    id: candidate.id,
    category: candidate.category,
    categoryLabel: CATEGORY_LABELS[candidate.category],
    name: candidate.name,
    subtitle: candidate.subtitle,
    overlapScore,
    supportCount: supporters.length,
    memberCount: members.length,
    scoreLabel: "Shared-tag coverage",
    memberNames: supporters.map(({ member }) => member.nickname),
    reasonsByMember,
    source: "demo-catalog",
    matchedTags: [...tags].filter((tag) =>
      matches.some(({ matched }) => matched.some((name) => normalized(name) === tag)),
    ),
  };
}

function validateMembers(input) {
  if (!Array.isArray(input) || input.length !== DEMO_MEMBERS.length) {
    throw new TypeError("The demo plan requires the three built-in sample members");
  }

  return DEMO_MEMBERS.map((sample) => {
    const submitted = input.find((member) => member?.id === sample.id);
    if (!submitted || !Array.isArray(submitted.favorites)) {
      throw new TypeError("Each built-in demo member must include favorites");
    }
    if (submitted.favorites.length > 20) {
      throw new RangeError("Each demo member can confirm at most 20 favorites");
    }
    const favorites = submitted.favorites.map((item) => {
      if (
        !item ||
        typeof item.name !== "string" ||
        item.name.trim().length === 0 ||
        item.name.length > 200 ||
        !Object.hasOwn(ENTITY_TYPES_BY_CATEGORY, item.category) ||
        !["entity", "tag"].includes(item.kind)
      ) {
        throw new TypeError("A confirmed favorite is invalid");
      }
      return {
        qlooId:
          typeof item.qlooId === "string" && item.qlooId.length <= 200
            ? item.qlooId
            : null,
        name: item.name.trim(),
        kind: item.kind,
        typeLabel:
          typeof item.typeLabel === "string" ? item.typeLabel.slice(0, 80) : "",
        category: item.category,
      };
    });
    return { ...sample, favorites };
  });
}

export function validateExplanation(value, candidates, members) {
  if (!value || !Array.isArray(value.picks) || value.picks.length !== 3) {
    return null;
  }

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const usedIds = new Set();
  const usedCategories = new Set();
  const memberIds = new Set(members.map((member) => member.id));
  const picks = [];

  for (const proposed of value.picks) {
    const candidate = candidateById.get(proposed?.id);
    if (
      !candidate ||
      usedIds.has(candidate.id) ||
      usedCategories.has(candidate.category) ||
      typeof proposed.headline !== "string" ||
      proposed.headline.trim().length < 8 ||
      proposed.headline.length > 180 ||
      !proposed.reasonsByMember ||
      typeof proposed.reasonsByMember !== "object"
    ) {
      return null;
    }

    const reasonsByMember = {};
    for (const memberId of memberIds) {
      const reason = proposed.reasonsByMember[memberId];
      const member = members.find((item) => item.id === memberId);
      if (
        typeof reason !== "string" ||
        reason.trim().length < 8 ||
        reason.length > 300
      ) {
        return null;
      }
      const grounded = interestsFor(member, candidate.category).some((favorite) =>
        normalized(reason).includes(normalized(favorite.name)),
      );
      if (!grounded) {
        return null;
      }
      reasonsByMember[memberId] = reason.trim();
    }

    usedIds.add(candidate.id);
    usedCategories.add(candidate.category);
    picks.push({
      ...candidate,
      headline: proposed.headline.trim(),
      reasonsByMember,
      explanationSource: "gemini",
    });
  }

  return usedCategories.size === Object.keys(ENTITY_TYPES_BY_CATEGORY).length
    ? picks
    : null;
}

async function explainWithGemini(candidates, members) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith("your_")) {
    return { picks: null, status: "not_configured" };
  }

  const prompt = {
    members: members.map((member) => ({
      id: member.id,
      nickname: member.nickname,
      favorites: member.favorites.map(({ category, name }) => ({ category, name })),
    })),
    candidates: candidates.map(
      ({ id, category, categoryLabel, name, subtitle, overlapScore, memberNames }) => ({
        id,
        category,
        categoryLabel,
        name,
        subtitle,
        overlapScore,
        matchedMembers: memberNames,
      }),
    ),
    instruction:
      "Choose exactly three candidates, one in each category, from this list. Do not invent candidates or scores. Return JSON only: {\"picks\":[{\"id\":\"...\",\"headline\":\"short concrete reason\",\"reasonsByMember\":{\"maya\":\"...\",\"jordan\":\"...\",\"avery\":\"...\"}}]}. Give each friend a grounded reason using only their listed favorites and the candidate details. Acknowledge a lower overlap honestly.",
  };

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: JSON.stringify(prompt) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.2,
          },
        }),
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!response.ok) {
      return { picks: null, status: `http_${response.status}` };
    }

    const payload = await response.json();
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("");
    if (!text) {
      return { picks: null, status: "empty_response" };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { picks: null, status: "invalid_json" };
    }
    const picks = validateExplanation(parsed, candidates, members);
    return picks
      ? { picks, status: "ready" }
      : { picks: null, status: "invalid_explanation" };
  } catch {
    return { picks: null, status: "request_failed" };
  }
}

function fallbackExplanation(candidates, members) {
  const bestByCategory = new Map();
  for (const category of Object.keys(ENTITY_TYPES_BY_CATEGORY)) {
    const best = candidates
      .filter((candidate) => candidate.category === category)
      .sort(
        (left, right) =>
          right.overlapScore - left.overlapScore ||
          left.name.localeCompare(right.name),
      )[0];
    if (best) {
      bestByCategory.set(category, {
        ...best,
        headline:
          best.overlapScore === 100
            ? `Every sample profile shares a taste signal with ${best.name}.`
            : `${best.supportCount} of ${best.memberCount} sample profiles share a taste signal with ${best.name}.`,
        explanationSource: "deterministic_fallback",
        reasonsByMember: Object.fromEntries(
          members.map((member) => [
            member.id,
            best.reasonsByMember[member.id] ??
              `Compare ${member.nickname}'s confirmed favorites before choosing this.`,
          ]),
        ),
      });
    }
  }
  return [...bestByCategory.values()];
}

export async function buildDemoPlan({
  members: submittedMembers = DEMO_MEMBERS,
  qlooClient = null,
  explain = explainWithGemini,
} = {}) {
  const members = validateMembers(submittedMembers);
  let live = { options: {}, errors: [], attempted: false };
  let qlooStatus = "not_configured";
  let qlooCapabilityError = null;

  if (qlooClient) {
    try {
      const capabilities = await callQlooTool(qlooClient, "qloo_capabilities");
      if (capabilities.adapter?.ready === true) {
        live = await loadQlooOptions(qlooClient, members);
        const hasPicks = Object.values(live.options).some(
          (options) => options.length > 0,
        );
        qlooStatus = live.errors.length
          ? hasPicks
            ? "partial"
            : "error"
          : "ready";
      } else {
        qlooStatus = "not_ready";
      }
    } catch (error) {
      qlooStatus = "error";
      qlooCapabilityError = error.message;
    }
  }

  const qlooPicks = Object.values(live.options)
    .flat()
    .sort(
      (left, right) =>
        right.overlapScore - left.overlapScore ||
        left.category.localeCompare(right.category) ||
        left.name.localeCompare(right.name),
    );

  const candidates = [];
  for (const category of Object.keys(ENTITY_TYPES_BY_CATEGORY)) {
    const qlooCategoryOptions = live.options[category] ?? [];
    if (qlooCategoryOptions.length > 0) {
      candidates.push(
        ...[...qlooCategoryOptions]
          .sort(
            (left, right) =>
              right.overlapScore - left.overlapScore ||
              left.name.localeCompare(right.name),
          )
          .slice(0, 5)
          .map((option) => ({
            ...option,
            categoryLabel: CATEGORY_LABELS[category],
          })),
      );
    } else {
      candidates.push(
        ...OFFLINE_CANDIDATES.filter((option) => option.category === category).map(
          (option) => ({
            ...scoreOfflineCandidate(option, members),
            categoryLabel: CATEGORY_LABELS[category],
          }),
        ),
      );
    }
  }

  let aiResult = { picks: null, status: "not_configured" };
  try {
    aiResult = await explain(candidates, members);
  } catch {
    aiResult = { picks: null, status: "request_failed" };
  }

  const aiPicks =
    aiResult.picks ??
    fallbackExplanation(candidates, members);
  const aiWarning = aiResult.picks
    ? null
    : aiResult.status === "not_configured"
      ? "GEMINI_API_KEY is not configured; the deterministic fallback uses the same candidates and measured overlap."
      : "Gemini output was unavailable or failed validation; the deterministic fallback uses the same candidates and measured overlap.";

  return {
    id: randomUUID(),
    city: DEMO_CITY,
    members,
    qloo: {
      status: qlooStatus,
      error: qlooCapabilityError,
      errors: live.errors,
      attempted: live.attempted,
      picks: qlooPicks,
      scoreDescription:
        "Coverage = the share of the three profiles whose individual Qloo top-10 included this entity; recommendations are not popularity scores.",
    },
    ai: {
      status: aiResult.status,
      mode: aiResult.picks ? "gemini" : "deterministic_fallback",
      warning: aiWarning,
      picks: aiPicks,
      scoreDescription:
        "Overlap = profiles sharing at least one listed taste tag with this sample-catalog pick.",
    },
  };
}
