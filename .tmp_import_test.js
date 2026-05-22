import { validateContract } from './backend/src/services/ai/ContractValidator.js';
console.log(typeof validateContract === 'function' ? 'ok' : 'no');
const res = validateContract({ type: 'message', text: 'hi' });
console.log(res);
