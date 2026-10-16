# Project notes

## Viewer

- The shot actions in the details panel (the "tray") and in the floating bar under the selected shot must always match 1:1: same actions, same order, same names. Both render `viewer/src/ShotActions.tsx`; change actions there only, never in one place. The `variant` prop changes only how they look. `tests/integration/viewer.test.ts` ("floats the shot's actions under a clicked shot") fails if they differ.
