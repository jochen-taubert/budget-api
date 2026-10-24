TF ?= terraform

.PHONY: install check typecheck test build tf-test init plan apply smoke logs destroy

install:          ## Abhängigkeiten installieren
	npm install

check:            ## Typprüfung, Unit-Tests und Build in einem
	npm run check

typecheck:
	npm run typecheck

test:             ## Unit-Tests (ohne AWS)
	npm test

build:            ## Lambda-Bundle nach dist/index.mjs
	npm run build

tf-test: build init   ## Terraform-Tests mit gemocktem AWS-Provider (ohne AWS)
	cd infra && $(TF) test

init:
	cd infra && $(TF) init

plan: build
	cd infra && $(TF) plan

apply: build
	cd infra && $(TF) apply

smoke:            ## End-to-End gegen die deployte API
	./scripts/smoke.sh

logs:             ## Lambda-Logs live verfolgen
	aws logs tail /aws/lambda/$$(cd infra && $(TF) output -raw function_name) --follow

destroy:
	cd infra && $(TF) destroy
