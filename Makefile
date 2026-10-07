.PHONY: help install build helper deploy check test lint typecheck clean secrets secrets-clear icons status e2e e2e-live fake-router previews van-eval

EXT_DIR := extension
RAY := node_modules/.bin/ray

SECRETS_SERVICE := tinycast-extensions
API_TOKEN_REF := op://common/api/SECRET
NETGEAR_PASSWORD_REF := op://Private/Netgear M2 Jo/Admin Passwort
VICTRON_KEY_REF := op://Private/Solar Camper Victron/Instant Readout Key
OP_ACCOUNT := tkrumm

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (frozen lockfile)
	cd $(EXT_DIR) && bun install --frozen-lockfile

HELPER_SRC := $(EXT_DIR)/helpers/van-ble/main.swift
HELPER_BIN := $(EXT_DIR)/assets/van-ble

# The Van Power BLE helper (Swift, CoreBluetooth + CommonCrypto, no deps) is
# spawned by the extension from environment.assetsPath. Tinycast Beta is the
# TCC-responsible process, so this stays a bare binary — no .app, no agent.
helper: ## Compile the van-ble BLE helper into extension/assets and run its --selftest
	@mkdir -p $(EXT_DIR)/assets
	swiftc -O -o $(HELPER_BIN) $(HELPER_SRC)
	@printf 'van-ble selftest: ' && $(HELPER_BIN) --selftest

build: helper ## Build the extension for Tinycast/Raycast "Add from folder"
	cd $(EXT_DIR) && $(RAY) build -e dist -o build
	@echo ""
	@echo "Built to $(EXT_DIR)/build/ — run 'make deploy' to update Tinycast (first install: Add from folder → $(CURDIR)/$(EXT_DIR)/build)"

TINYCAST_EXT_DIR := $(HOME)/Library/Application Support/com.tinycast.app.beta/extensions/jkrumm

# "Add from folder" is a one-time copy and re-adding does not reliably
# replace it, so deploy does that copy itself: package.json, built commands
# and assets/, never source maps. Tinycast reads a command's JS on each run.
deploy: build ## Build and copy straight into Tinycast Beta's installed extension
	@test -d "$(TINYCAST_EXT_DIR)" || { echo "Not installed yet — add $(CURDIR)/$(EXT_DIR)/build once via Settings → Extensions → Add from folder"; exit 1; }
	@cmp -s "$(EXT_DIR)/build/package.json" "$(TINYCAST_EXT_DIR)/package.json"; echo $$? > /tmp/tinycast-manifest-changed
	rsync -a --delete --exclude '*.map' "$(EXT_DIR)/build/" "$(TINYCAST_EXT_DIR)/"
	@echo "Deployed to $(TINYCAST_EXT_DIR)"
	@# Tinycast only rescans manifests at launch — a new/renamed command needs a restart
	@if [ "$$(cat /tmp/tinycast-manifest-changed)" != 0 ]; then \
		echo "Manifest changed — restarting Tinycast Beta so it rescans commands"; \
		osascript -e 'quit app "Tinycast Beta"'; sleep 2; open -a "Tinycast Beta"; \
	fi

typecheck: ## tsc --noEmit
	cd $(EXT_DIR) && bunx tsc --noEmit

# Not `ray lint`: its manifest check looks the author up on raycast.com and
# fails for an account that doesn't exist — this extension is never published.
lint: ## eslint + prettier (what ray lint runs, minus the Store owner lookup)
	cd $(EXT_DIR) && bunx eslint src && bunx prettier --check src

test: ## Run the unit test suite
	cd $(EXT_DIR) && bun run test

e2e: ## Run the e2e render harness — mounts every command's real React tree against fixtures, catches render crashes before Tinycast does
	cd $(EXT_DIR) && bun run e2e

e2e-live: ## E2E_LIVE=1 required — also renders netgear/battery/claude-usage/hub against real sources (read-only), writes markdown to /tmp/tinycast-e2e
	cd $(EXT_DIR) && E2E_LIVE=1 bun run e2e

fake-router: ## Run the fake Netgear M2 on 127.0.0.1:8188 (password "fake") — point the netgearHost preference at it to click-test without the real router; Ctrl-C stops it
	cd $(EXT_DIR) && bun scripts/fake-router.ts

previews: ## Render every production hero + the chart gallery to /tmp/tinycast-previews/*.{dark,light}.png and sheet-*.png (ARGS="usage --coresvg" to filter / use macOS' own SVG decoder)
	cd $(EXT_DIR) && bun scripts/chart-previews.ts $(ARGS)

van-eval: ## SoC estimator tuning loop: replay the estimator leave-one-out over van-log.jsonl / van-trends.jsonl from the support dir (ARGS="<support-dir>" to override)
	cd $(EXT_DIR) && bun scripts/van-eval.ts $(ARGS)

check: helper typecheck lint test e2e ## helper selftest + typecheck + lint + test + e2e

clean: ## Remove build artifacts
	rm -rf $(EXT_DIR)/dist $(EXT_DIR)/build

secrets: ## Pre-seed Keychain from 1Password (one biometric pass) so Tinycast never has to prompt
	@echo "Resolving apiToken from $(API_TOKEN_REF)…"
	@API_TOKEN=$$(op read "$(API_TOKEN_REF)" --account $(OP_ACCOUNT)) && \
		security add-generic-password -U -s $(SECRETS_SERVICE) -a apiToken -w "$$API_TOKEN"
	@echo "Resolving netgearPassword from $(NETGEAR_PASSWORD_REF)…"
	@NETGEAR_PW=$$(op read "$(NETGEAR_PASSWORD_REF)" --account $(OP_ACCOUNT)) && \
		security add-generic-password -U -s $(SECRETS_SERVICE) -a netgearPassword -w "$$NETGEAR_PW"
	@echo "Cached apiToken + netgearPassword in Keychain (service: $(SECRETS_SERVICE))."
	@echo "Resolving victronKey from $(VICTRON_KEY_REF)…"
	@VICTRON_KEY=$$(op read "$(VICTRON_KEY_REF)" --account $(OP_ACCOUNT) 2>/dev/null) && \
		security add-generic-password -U -s $(SECRETS_SERVICE) -a victronKey -w "$$VICTRON_KEY" && \
		echo "Cached victronKey in Keychain." || \
		echo "victronKey skipped — $(VICTRON_KEY_REF) not found (add the field in 1Password, then re-run make secrets)."

secrets-clear: ## Remove cached Keychain entries (forces re-resolution from 1Password next time)
	-security delete-generic-password -s $(SECRETS_SERVICE) -a apiToken
	-security delete-generic-password -s $(SECRETS_SERVICE) -a netgearPassword
	-security delete-generic-password -s $(SECRETS_SERVICE) -a victronKey
	@echo "Cleared cached secrets from Keychain (service: $(SECRETS_SERVICE))."

status: ## Debug readout: command metadata, watchdog log, LocalStorage sizes, deployed-vs-built check
	python3 scripts/tinycast-status.py

NETGEAR_LOG := $(HOME)/Library/Application Support/com.tinycast.app.beta/extension-support/jkrumm/netgear.log

logs: ## Last 100 lines of the extension's own Netgear action log (console.log is dead in Tinycast)
	@test -f "$(NETGEAR_LOG)" && tail -n 100 "$(NETGEAR_LOG)" || echo "No log yet: $(NETGEAR_LOG)"

icons: ## Regenerate 512x512 PNG command icons from assets/src/*.svg via rsvg-convert
	@mkdir -p $(EXT_DIR)/assets
	@for svg in $(EXT_DIR)/assets/src/*.svg; do \
		name=$$(basename "$$svg" .svg); \
		rsvg-convert -w 512 -h 512 "$$svg" -o "$(EXT_DIR)/assets/$$name.png"; \
		echo "Generated $(EXT_DIR)/assets/$$name.png"; \
	done
