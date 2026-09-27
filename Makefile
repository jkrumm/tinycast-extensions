.PHONY: help install build check test lint typecheck clean

EXT_DIR := extension
RAY := node_modules/.bin/ray

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (frozen lockfile)
	cd $(EXT_DIR) && bun install --frozen-lockfile

build: ## Build the extension for Tinycast/Raycast "Add from folder"
	cd $(EXT_DIR) && $(RAY) build -e dist -o build
	@echo ""
	@echo "Built to $(EXT_DIR)/build/ — in Tinycast: Settings → Extensions → Install → Add from folder → $(CURDIR)/$(EXT_DIR)/build"
	@echo "Re-run this after every change and re-add the folder (in-place update on re-add is unconfirmed)."

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
