// A fixture kit whose only event never fires — for `eventkit-flow simulate` when
// nothing matches the payload.
import { createEventKit, defineEvent, job } from '../../../index.js';
import { fakeSource } from '../../../testing/index.js';

export const kit = createEventKit(fakeSource()).registerEvents([
  defineEvent({ name: 'never.fires', detector: () => false, jobs: [job(() => {}, { name: 'noop' })] }),
]);
