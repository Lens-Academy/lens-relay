# Regression Detector

Detects content regressions in relay-synced GitHub repos: files whose content reverted to a previous state due to sync errors, merge conflicts, or accidents.

```bash
# Check lens-folder-relay (last 7 days, default 60-minute minimum gap)
python3 scripts/detect-regressions.py ~/code/lens-folder-relay

# Check with longer lookback
python3 scripts/detect-regressions.py ~/code/lens-folder-relay --days 90

# JSON output for programmatic use
python3 scripts/detect-regressions.py ~/code/lens-folder-relay --output json

# Show all reversions including short undo/redo (noisy)
python3 scripts/detect-regressions.py ~/code/lens-folder-relay --min-gap 0

# Only show reversions spanning 24+ hours
python3 scripts/detect-regressions.py ~/code/lens-folder-relay --min-gap 1440
```

Three detectors: exact reversion (blob hash match), near-exact reversion (line-set similarity >=90%), and full wipe (content replaced with near-empty). The `--min-gap` flag (default: 60 minutes) filters out short-lived undo/redo cycles that are normal editing.

Fetch the repos before running:

```bash
cd ~/code/lens-folder-relay && git fetch origin main
```
