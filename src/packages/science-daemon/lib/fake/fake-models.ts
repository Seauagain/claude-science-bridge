/**
 * What the fake daemon answers to `GET /models`: three models that differ in the effort levels
 * they take, in the shape docs/protocol.md records.
 */
export const FAKE_MODELS = {
  models: {
    anthropic: [
      {
        id: "model-large",
        name: "Large",
        effort: {
          supported: true,
          options: [
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium", recommended: true },
            { id: "high", name: "High" },
            { id: "max", name: "Max" },
          ],
        },
      },
      {
        id: "model-small",
        name: "Small",
        effort: {
          supported: true,
          options: [
            { id: "low", name: "Low", recommended: true },
            { id: "medium", name: "Medium" },
          ],
        },
      },
      { id: "model-basic", name: "Basic", effort: { supported: false, options: [] } },
    ],
  },
  default_model_id: "model-large",
  default_effort: "medium",
};
