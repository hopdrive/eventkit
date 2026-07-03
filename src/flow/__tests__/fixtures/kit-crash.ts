// A fixture kit whose detector throws — for `eventkit-flow simulate` reporting a
// detector crash (dryRun catches it and surfaces the error).
import { createEventKit, defineEvent, job } from '../../../index.js';
import { fakeSource } from '../../../testing/index.js';

export const kit = createEventKit(fakeSource()).registerEvents([
  defineEvent({ name: 'crashy', detector: () => { throw new Error('detector boom'); }, jobs: [job(() => {}, { name: 'x' })] }),
]);
