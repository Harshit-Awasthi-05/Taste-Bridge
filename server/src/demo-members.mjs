const favorite = (category, kind, name, typeLabel) => ({
  qlooId: null,
  name,
  kind,
  typeLabel,
  category,
});

const demoMembers = [
  {
    id: "maya",
    roomId: "demo",
    nickname: "Maya",
    isReady: true,
    favorites: [
      favorite("dining", "tag", "Japanese cuisine", "Cuisine"),
      favorite("dining", "tag", "handmade noodles", "Dining style"),
      favorite("dining", "tag", "cozy dining", "Atmosphere"),
      favorite("music", "entity", "Khruangbin", "Artist"),
      favorite("music", "tag", "indie pop", "Genre"),
      favorite("music", "tag", "instrumental grooves", "Sound"),
      favorite("film_tv", "tag", "animation", "Genre"),
      favorite("film_tv", "tag", "science fiction", "Genre"),
      favorite("film_tv", "entity", "Spider-Man: Into the Spider-Verse", "Movie"),
    ],
  },
  {
    id: "jordan",
    roomId: "demo",
    nickname: "Jordan",
    isReady: true,
    favorites: [
      favorite("dining", "tag", "Japanese cuisine", "Cuisine"),
      favorite("dining", "tag", "shared plates", "Dining style"),
      favorite("dining", "tag", "cozy dining", "Atmosphere"),
      favorite("music", "entity", "Khruangbin", "Artist"),
      favorite("music", "tag", "indie pop", "Genre"),
      favorite("music", "tag", "dream pop", "Sound"),
      favorite("film_tv", "tag", "animation", "Genre"),
      favorite("film_tv", "tag", "science fiction", "Genre"),
      favorite("film_tv", "entity", "Everything Everywhere All at Once", "Movie"),
    ],
  },
  {
    id: "avery",
    roomId: "demo",
    nickname: "Avery",
    isReady: true,
    favorites: [
      favorite("dining", "tag", "Japanese cuisine", "Cuisine"),
      favorite("dining", "tag", "handmade noodles", "Dining style"),
      favorite("dining", "tag", "vegetarian-friendly", "Dietary"),
      favorite("music", "entity", "Khruangbin", "Artist"),
      favorite("music", "tag", "indie pop", "Genre"),
      favorite("music", "tag", "dream pop", "Sound"),
      favorite("film_tv", "tag", "animation", "Genre"),
      favorite("film_tv", "tag", "science fiction", "Genre"),
      favorite("film_tv", "entity", "Spider-Man: Into the Spider-Verse", "Movie"),
    ],
  },
];

for (const member of demoMembers) {
  for (const item of member.favorites) {
    Object.freeze(item);
  }
  Object.freeze(member.favorites);
  Object.freeze(member);
}

export const DEMO_MEMBERS = Object.freeze(demoMembers);
