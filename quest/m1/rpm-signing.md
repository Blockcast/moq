# [S] Signed RPMs install from rpm.moq.dev

## Goal

`dnf install moq moq-relay gstreamer1-moq` from rpm.moq.dev succeeds on
Fedora and RHEL with the repository's `gpgcheck=1` left on, following the
install lines the docs print.

## Plan

- Today every install fails. `moq.repo` sets `gpgcheck=1` and
  `repo_gpgcheck=1`, but `infra/rpm/publish.sh` signs only `repomd.xml`, so
  dnf refuses each package: "The package is not signed". Reproduced on a
  Fedora 43 container against `gstreamer1-moq-0.4.8` and `moq-0.12.8`;
  `rpm -Kv` shows digests and no signature.
- Sign each package with the existing `SIGNING_KEY` (`rpmsign --addsign`,
  `%_gpg_name` set to the imported key id) before `createrepo_c`, so the
  repodata checksums cover the signed files. The pool is pulled back from R2
  on every run, so sign the whole merged pool, not just the new artifacts; the
  packages already published are unsigned and must be replaced.
- Keep `gpgcheck=1`. Dropping it to lean on `repo_gpgcheck` alone would
  paper over the gap rather than close it.
- The docs print `sudo dnf config-manager --add-repo`, which is dnf4 syntax;
  Fedora 41+ ships dnf5, which rejects it. Replace it with
  `sudo curl -fsSL https://rpm.moq.dev/moq.repo -o /etc/yum.repos.d/moq.repo`,
  which works on both, in `doc/setup/install.md`, `rs/moq-relay/README.md`,
  and `rs/moq-gst/README.md`. The "Fedora 39+" note in the install doc goes
  with it.
- Verify with a `workflow_dispatch` of `rpm-repo.yml`, then a clean Fedora and
  a clean Rocky 9 container: add the repo as documented, install all three
  packages with `gpgcheck=1`, and check `rpm -Kv` reports the project key.

## Related

- [Workflows call just](/quest/m1/tooling/workflows-call-just.md) - moves the
  rpm publish step behind `just infra rpm publish`; either can land first
