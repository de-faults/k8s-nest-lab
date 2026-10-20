# Local EKS-like lab. Every target uses the lab kubeconfig, never ~/.kube/config.
export KUBECONFIG := $(CURDIR)/.kube/kubeconfig.yaml

REGISTRY ?= localhost:5001
IMAGE    ?= $(REGISTRY)/nest-lab
# Keep in sync with `images.newTag` in k8s/overlays/*/kustomization.yaml.
TAG      ?= 0.1.0
ENV      ?= staging
NS       := nest-lab-$(if $(filter production,$(ENV)),prod,$(ENV))
API_KEY  ?= lab-$(ENV)-api-key-change-me
LB_PORT  ?= 8080

.DEFAULT_GOAL := help
.PHONY: help up wait stop start down image deploy secret status smoke logs undeploy

help: ## Show targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-10s %s\n", $$1, $$2}'
	@echo "\n  Use the cluster from your shell:  export KUBECONFIG=$(KUBECONFIG)"

up: ## Create/start the cluster (control plane, 3 workers, LB, registry)
	@mkdir -p .kube
	docker compose up -d
	@$(MAKE) --no-print-directory wait

wait:
	@echo "waiting for kubeconfig..."; until [ -s $(KUBECONFIG) ]; do sleep 2; done
	@echo "waiting for 4 Ready nodes..."; until [ "$$(kubectl get nodes --no-headers 2>/dev/null | grep -c ' Ready ')" = 4 ]; do sleep 2; done
	kubectl -n kube-system rollout status deploy/coredns deploy/metrics-server --timeout=180s
	@echo "waiting for traefik..."; until kubectl -n kube-system get deploy/traefik >/dev/null 2>&1; do sleep 3; done
	kubectl -n kube-system rollout status deploy/traefik --timeout=180s
	kubectl get nodes -L topology.kubernetes.io/zone

stop: ## Pause the cluster, keep all state
	docker compose stop

start: ## Resume a paused cluster
	docker compose start
	@$(MAKE) --no-print-directory wait

down: ## Destroy the cluster and all volumes (registry images included)
	docker compose down -v
	rm -f $(KUBECONFIG)

image: ## Build and push the app image: make image TAG=0.2.0
	docker build --build-arg APP_VERSION=$(TAG) -t $(IMAGE):$(TAG) .
	docker push $(IMAGE):$(TAG)

secret: ## Create/update the app Secret (stand-in for Secrets Manager + External Secrets)
	kubectl create namespace $(NS) --dry-run=client -o yaml | kubectl apply -f -
	kubectl -n $(NS) create secret generic nest-lab-secret \
		--from-literal=API_KEY=$(API_KEY) --dry-run=client -o yaml | kubectl apply -f -

deploy: secret ## Deploy an overlay: make deploy ENV=staging|production
	kubectl apply -k k8s/overlays/$(ENV)
	kubectl -n $(NS) rollout status deploy/nest-lab --timeout=180s

status: ## Show the app's resources in ENV
	kubectl -n $(NS) get deploy,rs,pod,svc,ingress,hpa,pdb,cm,secret -o wide

smoke: ## Call the app through the load balancer and ingress
	curl -fsS http://$(if $(filter production,$(ENV)),api,$(ENV)).nest-lab.localhost:$(LB_PORT)/ && echo
	curl -fsS http://$(if $(filter production,$(ENV)),api,$(ENV)).nest-lab.localhost:$(LB_PORT)/config && echo

logs: ## Tail logs from all app pods in ENV
	kubectl -n $(NS) logs -l app.kubernetes.io/name=nest-lab -f --prefix --max-log-requests=10

undeploy: ## Delete everything for ENV (namespace included)
	kubectl delete -k k8s/overlays/$(ENV) --ignore-not-found
