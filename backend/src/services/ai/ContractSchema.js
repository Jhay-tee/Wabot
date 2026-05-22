export const AI_CONTRACT_SCHEMA = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string", enum: ["message", "action_request", "refusal"] },
    text: { type: "string" },
    reason: { type: "string" },
    action: { type: "string" },
    params: { type: "object" }
  },
  additionalProperties: false,
};

export default AI_CONTRACT_SCHEMA;
