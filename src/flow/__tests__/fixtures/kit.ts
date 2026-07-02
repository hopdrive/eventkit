// A built EventKit fixture for the eventkit-flow CLI tests. The CLI imports a module
// and picks its `kit` export (no handler runs — describe() is a pure registry walk).
import { createEventKit, defineEvent, job } from '../../../index.js';
import { fakeSource } from '../../../testing/index.js';

export const kit = createEventKit(fakeSource()).registerEvents([
  defineEvent({
    name: 'thing.happened',
    detector: () => true,
    jobs: [job(() => {}, { name: 'doThing' })],
  }),
]);
