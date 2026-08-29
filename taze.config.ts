export default {
  includeLocked: true,
  maturityPeriodExclude: ["@vercel/*", "eve"],
  mode: "major",
  packageMode: {
    "@types/node": "minor",
    typescript: "minor",
  },
  recursive: true,
};
