# Tests first

Tests are written up front from the lead's plan by a lightweight worker, builders
build against them, and builders never touch them. The aim is no time spent
fixing tests after the build.

1. **Plan.** Each unit's behavior is stated as checkable acceptance cases: inputs,
   expected observable result, and the level each one lives at (unit or table
   test, real-database test, end-to-end test for wiring and timing). A unit the
   lead cannot state this way is not ready to dispatch.
2. **Test task.** Add a test task per unit ahead of the build task, routed to the
   lightest executor that can carry it, with an `--accept` that names why the
   tests fail on the unchanged code ("fails on main because install does not
   retry"); without that reason the evidence check can hold the task. Its brief
   is the acceptance cases, the
   lead's numbered owner and lead decisions those cases depend on (quoted, with
   each case citing the decision number it encodes), and the allowed test and
   minimal-contract paths, nothing about how to build. The
   test worker writes the tests and only the contract they need to compile
   (types, signatures, a module that throws "not implemented"), commits them as
   the unit branch's first commit, and returns the SHA, the locked test files,
   the run command, every older test it amended or removed because it asserts
   the opposite of a numbered decision ("none" with the command it ran), and a
   red run showing each test fails for its stated reason
   rather than on an import or setup error. A skipped test is not red, so the
   red run reports zero skips. Dispatch only after the owner decisions the cases
   depend on are answered.
3. **Build task.** Add it with `--after <test task id>`. `claim` refuses while the
   test task is open and `done` refuses a red test task even with `--force`. When
   the red run returns, check every expected value in it against the numbered
   decisions; a mismatch goes back to the test worker as an amendment before the
   builder is released. Then record the baseline with `decide <test id> --summary
   <SHA and red result> --by <lead>`, release the builder with `after <build id>
   none`, then dispatch. Close the test task after the builder's green run, but
   on its own red run: the evidence check counts a passing test against a
   test-writing task, so the green run never goes in as acceptance evidence or
   in the summary. Attach it with `evidence <test id> --supporting <item>`,
   which the check does not read. The test worker then runs `jev-ask.ts
   --check-evidence --task <test id> --by <owner> --summary <red result at the
   lock commit> --phase "red run" --current-evidence <retained red-run path>`
   and `done`. The
   build brief names the test commit, the locked files, the run command and the
   line `Older tests changed: <list> | none (<command>)`, and says: make these pass; do not edit, skip, delete, loosen or re-time a locked
   file. A builder may add tests in new files. A builder who believes a locked
   test is wrong stops that part, reports the test, reason and evidence to the
   lead, and continues with the rest.
4. **Wrong test.** The lead decides. If the test is wrong or the plan changed, a
   fresh test worker amends it in its own commit and the lead sends the builder
   the new SHA. The builder never makes that edit.
5. **Gate.** Before review, the lead (or the reviewer, as its first check) runs
   `git log -p <test commit>..<head> -- <locked files>` and checks each change
   against the lead's assigned test-worker commits, including edits later
   reverted; author names alone are not proof. Any other change is blocking,
   whatever the suite says.

This covers behavior tests. Screenshots, device runs and other runtime evidence
stay with the builder and the QA worker. Skip the test task only for
documentation-only changes, specs, investigations and throwaway prototypes, and
say so in the task.
