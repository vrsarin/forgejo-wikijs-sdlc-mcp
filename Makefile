.PHONY: install lint audit build check test images compose-check verify test-security trivy-fs trivy-secrets trivy-images sbom pre-commit

PACKAGES := src/forgejo-mcp-server src/wikijs-sdlc-mcp-server src/homeassistant-mcp-server
IMAGES := forgejo-workflow-mcp:dev wikijs-sdlc-mcp:dev homeassistant-mcp:dev
TRIVY_IMAGE := aquasec/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c
TRIVY_CACHE := sdlc-mcp-trivy-cache

install:
	npm ci --ignore-scripts
	@for package in $(PACKAGES); do npm --prefix $$package ci --ignore-scripts || exit 1; done
	npm run prepare

lint:
	npm run lint

audit:
	npm audit
	@for package in $(PACKAGES); do npm --prefix $$package audit || exit 1; done

build:
	@for package in $(PACKAGES); do npm --prefix $$package run build || exit 1; done

check:
	@for package in $(PACKAGES); do npm --prefix $$package run check || exit 1; done

test:
	@for package in $(PACKAGES); do npm --prefix $$package test || exit 1; done
	node --test src/shared/homeassistant-oauth.test.mjs
	node --test scripts/validate-pr-changelog.test.mjs

images:
	docker build -f src/forgejo-mcp-server/Dockerfile -t forgejo-workflow-mcp:dev .
	docker build -f src/wikijs-sdlc-mcp-server/Dockerfile -t wikijs-sdlc-mcp:dev .
	docker build -f src/homeassistant-mcp-server/Dockerfile -t homeassistant-mcp:dev .

compose-check:
	docker compose --env-file .env.streamable-http.example -f compose.streamable-http.yaml --profile forgejo --profile wikijs --profile homeassistant config --quiet
	docker compose --env-file .env.streamable-http.example -f compose.streamable-http.yaml -f compose.streamable-http-tls.yaml --profile forgejo --profile wikijs --profile homeassistant config --quiet

trivy-fs:
	docker run --rm --mount type=bind,src=$(CURDIR),dst=/workspace,readonly --mount type=volume,src=$(TRIVY_CACHE),dst=/root/.cache/trivy $(TRIVY_IMAGE) fs --scanners vuln,misconfig --skip-files '**/Dockerfile.dockerignore' --severity HIGH,CRITICAL --ignore-unfixed=false --format table --exit-code 1 /workspace

trivy-secrets:
	docker run --rm --mount type=bind,src=$(CURDIR),dst=/workspace,readonly --mount type=volume,src=$(TRIVY_CACHE),dst=/root/.cache/trivy $(TRIVY_IMAGE) fs --scanners secret --format table --exit-code 1 /workspace
	@echo "Repository secret scan: 0 findings"
	@for image in $(IMAGES); do docker run --rm --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock --mount type=volume,src=$(TRIVY_CACHE),dst=/root/.cache/trivy $(TRIVY_IMAGE) image --scanners secret --format table --exit-code 1 $$image || exit 1; echo "$$image secret scan: 0 findings"; done

trivy-images:
	@for image in $(IMAGES); do docker run --rm --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock --mount type=volume,src=$(TRIVY_CACHE),dst=/root/.cache/trivy $(TRIVY_IMAGE) image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed=false --format table --exit-code 1 $$image || exit 1; done

sbom:
	mkdir -p .artifacts/sbom
	@for image in $(IMAGES); do name=$${image%%:*}; docker run --rm --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock --mount type=volume,src=$(TRIVY_CACHE),dst=/root/.cache/trivy $(TRIVY_IMAGE) image --format cyclonedx $$image > .artifacts/sbom/$$name.cdx.json || exit 1; node -e 'const fs=require("node:fs"); const bom=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (bom.bomFormat!=="CycloneDX" || !Array.isArray(bom.components) || bom.components.length===0) process.exit(1); console.log(`$${process.argv[1]}: $${bom.components.length} components`)' .artifacts/sbom/$$name.cdx.json || exit 1; done

test-security: trivy-fs trivy-secrets trivy-images sbom

pre-commit:
	npm run precommit

verify: lint audit check test compose-check
