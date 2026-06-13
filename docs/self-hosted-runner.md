# CI on a self-hosted runner

This repo's CI (`.github/workflows/ci.yml`) runs on a **self-hosted** runner
(`runs-on: [self-hosted]`). Self-hosted runners are free — including for private
repositories — and run on a machine you control (e.g. your Mac), which sidesteps
GitHub-hosted Actions minutes entirely.

## One-time setup

1. Get a registration token:
   **GitHub → repo → Settings → Actions → Runners → "New self-hosted runner"**.
   Copy the token from the `./config.sh --token <TOKEN>` line it shows.

2. On the machine that should run CI:

   ```bash
   ./scripts/setup-self-hosted-runner.sh <TOKEN>
   ```

   The script detects your OS/arch, downloads the latest runner into
   `~/actions-runner-voicebridge`, and registers it with the `self-hosted` label.

3. Start the runner:

   ```bash
   cd ~/actions-runner-voicebridge
   ./run.sh                          # foreground
   # or run it as a background service:
   sudo ./svc.sh install && sudo ./svc.sh start
   ```

Once the runner is online, every pull request (and push to `main`) runs
`npm ci`, `node --check server.js`, and `npm test` on it, and the CI badge in the
README turns green.

## Notes

- Node 20 is provisioned per-run by `actions/setup-node`, so you don't need a
  specific Node version pre-installed (a recent Node + `git` is enough).
- Keep the runner machine private; a self-hosted runner executes whatever a PR's
  workflow defines. For a public repo, prefer GitHub-hosted runners instead.
- To stop using it: `Settings → Actions → Runners → … → Remove`, or
  `./config.sh remove --token <TOKEN>` from the runner directory.
