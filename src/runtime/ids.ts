// Id generation for the runtime.
import { v4 as uuidv4 } from 'uuid';
import { asInvocationId, asCorrelationId, type InvocationId, type CorrelationId } from '../core/index.js';

export const newUuid = (): string => uuidv4();
export const newInvocationId = (): InvocationId => asInvocationId(uuidv4());
export const newCorrelationId = (): CorrelationId => asCorrelationId(uuidv4());
