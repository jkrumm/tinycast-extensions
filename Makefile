.PHONY: help install build deploy check test lint typecheck clean secrets secrets-clear icons

EXT_DIR := extension
RAY := node_modules/.bin/ray

SECRETS_SERVICE := tinycast-extensions
API_TOKEN_REF := op://common/api/SECRET
NETGEAR_PASSWORD_REF := op://Private/Netgear M2 Jo/Admin Passwort
OP_ACCOUNT := tkrumm

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (frozen lockfile)
	cd $(EXT_DIR) && bun install --frozen-lockfile

build: ## Build the extension for Tinycast/Raycast "Add from folder"
	cd $(EXT_DIR) && $(RAY) build -e dist -o build
	@echo ""
	@echo "Built to $(EXT_DIR)/build/ — run 'make deploy' to update Tinycast (first install: Add from folder → $(CURDIR)/$(EXT_DIR)/build)"

TINYCAST_EXT_DIR := $(HOME)/Library/Application Support/com.tinycast.app.beta/extensions/jkrumm

# "Add from folder" is a one-time copy and re-adding does not reliably
# replace it, so deploy does that copy itself: package.json, built commands
# and assets/, never source maps. Tinycast reads a command's JS on each run.
deploy: build ## Build and copy straight into Tinycast Beta's installed extension
	@test -d "$(TINYCAST_EXT_DIR)" || { echo "Not installed yet — add $(CURDIR)/$(EXT_DIR)/build once via Settings → Extensions → Add from folder"; exit 1; }
	rsync -a --delete --exclude '*.map' "$(EXT_DIR)/build/" "$(TINYCAST_EXT_DIR)/"
	@echo "Deployed to $(TINYCAST_EXT_DIR)"

typecheck: ## tsc --noEmit
	cd $(EXT_DIR) && bunx tsc --noEmit

# Not `ray lint`: its manifest check looks the author up on raycast.com and
# fails for an account that doesn't exist — this extension is never published.
lint: ## eslint + prettier (what ray lint runs, minus the Store owner lookup)
	cd $(EXT_DIR) && bunx eslint src && bunx prettier --check src

test: ## Run the unit test suite
	cd $(EXT_DIR) && bun run test

check: typecheck lint test ## typecheck + lint + test

clean: ## Remove build artifacts
	rm -rf $(EXT_DIR)/dist $(EXT_DIR)/build

secrets: ## Pre-seed Keychain from 1Password (one biometric pass) so Tinycast never has to prompt
	@echo "Resolving apiToken from $(API_TOKEN_REF)…"
	@API_TOKEN=$$(op read "$(API_TOKEN_REF)" --account $(OP_ACCOUNT)) && \
		security add-generic-password -U -s $(SECRETS_SERVICE) -a apiToken -w "$$API_TOKEN"
	@echo "Resolving netgearPassword from $(NETGEAR_PASSWORD_REF)…"
	@NETGEAR_PW=$$(op read "$(NETGEAR_PASSWORD_REF)" --account $(OP_ACCOUNT)) && \
		security add-generic-password -U -s $(SECRETS_SERVICE) -a netgearPassword -w "$$NETGEAR_PW"
	@echo "Cached both secrets in Keychain (service: $(SECRETS_SERVICE))."

secrets-clear: ## Remove cached Keychain entries (forces re-resolution from 1Password next time)
	-security delete-generic-password -s $(SECRETS_SERVICE) -a apiToken
	-security delete-generic-password -s $(SECRETS_SERVICE) -a netgearPassword
	@echo "Cleared cached secrets from Keychain (service: $(SECRETS_SERVICE))."

icons: ## Regenerate 512x512 PNG command icons from assets/src/*.svg via rsvg-convert
	@mkdir -p $(EXT_DIR)/assets
	@for svg in $(EXT_DIR)/assets/src/*.svg; do \
		name=$$(basename "$$svg" .svg); \
		rsvg-convert -w 512 -h 512 "$$svg" -o "$(EXT_DIR)/assets/$$name.png"; \
		echo "Generated $(EXT_DIR)/assets/$$name.png"; \
	done
