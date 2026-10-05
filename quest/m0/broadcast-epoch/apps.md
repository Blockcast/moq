# [M] Apps publish under epochs and play bare names

## Goal

`moq-cli` publish and play, `@moq/publish`, `@moq/watch`, and `demo/web`
publish each run under a fresh epoch (`Path::mint_epoch`, `Path.mintEpoch`;
publishing does not mint one by default). Each publish run is a new epoch, so a restart while the
old route lingers is a new broadcast rather than a resume into the old one,
which stalls viewers until the new run's group sequence catches up. Watching
a bare name switches to a republish within an RTT. The UI and logs show the
full epoch path, and a watch link can pin one.

## Plan

- Publish sides mint the epoch once per run where they create the broadcast.
  Check that nothing caches the announced path across a restart.
- Watch sides on the old JS path wait for an announcement covering the bare
  name; `@moq/net` now treats an epoch below it as routing the name.
- Watch sides handle "the broadcast changed" as a fresh catalog and decoder
  reset. Test a republish mid-playback in the browser and native players.
- Update `doc/bin/cli.md` and every example invocation that shows a published
  path.
