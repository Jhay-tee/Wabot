import Ajv from 'ajv';
import AI_CONTRACT_SCHEMA from './ContractSchema.js';

const ajv = new Ajv({ allErrors: true });
const validateFn = ajv.compile(AI_CONTRACT_SCHEMA);

export function validateContract(obj) {
  const ok = validateFn(obj);
  return { valid: Boolean(ok), errors: validateFn.errors || null };
}

export default { validateContract };
