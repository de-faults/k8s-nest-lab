# k8s-nest-lab

NestJS app + local Kubernetes cluster ที่จำลอง production บน AWS EKS ให้มากที่สุด รันฟรีบนเครื่องด้วย Docker Compose อย่างเดียว ไม่ต้องลง kind/k3d/minikube

แบบฝึกหัดทั้งหมดอยู่ใน **[LAB.md](LAB.md)**

## โครงสร้าง cluster

```
            localhost:8080 (HTTP) / :8404 (LB stats)
                         │
                   ┌─────▼─────┐   "NLB": HAProxy TCP → ทุก worker, มี health check
                   │    lb     │
                   └─────┬─────┘
      ┌──────────────────┼──────────────────┐
┌─────▼──────┐     ┌─────▼──────┐     ┌─────▼──────┐
│ worker-1a  │     │ worker-1b  │     │ worker-1c  │   "managed node group" 3 AZ
│ ap-se-1a   │     │ ap-se-1b   │     │ ap-se-1c   │   Traefik ingress + app pods
└────────────┘     └────────────┘     └────────────┘
            ┌───────────────┐   ┌──────────────────┐
            │ control-plane │   │ registry :5001   │  "ECR"
            │ (tainted)     │   └──────────────────┘
            └───────────────┘   localhost:6443 = API server
```

| ใน lab | บน AWS จริง |
|---|---|
| `control-plane` (k3s server, มี taint ไม่รับ workload) | EKS control plane (AWS ดูแล) |
| `worker-1a/1b/1c` + label `topology.kubernetes.io/zone` | Managed node group กระจาย 3 AZ |
| `lb` (HAProxy) | NLB / ALB หน้า cluster |
| Traefik `Ingress` (`ingressClassName: traefik`) | AWS Load Balancer Controller (`ingressClassName: alb`) |
| `registry` ที่ `localhost:5001` | ECR |
| `make secret` (kubectl create secret) | Secrets Manager + External Secrets Operator |
| ServiceAccount `nest-lab` | IRSA / EKS Pod Identity (annotation role-arn) |
| NetworkPolicy (k3s kube-router) | VPC CNI network policy / Calico |
| metrics-server + HPA | เหมือนกัน (+ Karpenter/Cluster Autoscaler สำหรับ node) |
| `local-path` StorageClass | EBS CSI (gp3) |
| Kustomize overlays `staging` / `production` | GitOps (Argo CD / Flux) |
| Pod Security `restricted` บน namespace | Pod Security Standards / Kyverno policy |

## ต้องมี

- Docker Desktop (RAM ≥ 4 GB ให้ Docker)
- `kubectl`, `make`, `curl`
- Node.js 24 (ถ้าจะรัน app นอก container)

## เริ่มใช้งาน

```bash
make up                         # สร้าง cluster (~1 นาที)
make image                      # build + push localhost:5001/nest-lab:0.1.0
make deploy                     # deploy overlay staging
make deploy ENV=production      # deploy overlay production
make smoke                      # curl ผ่าน LB → Traefik → Service → Pod

export KUBECONFIG=$PWD/.kube/kubeconfig.yaml   # ใช้ kubectl จาก shell
kubectl get nodes -L topology.kubernetes.io/zone
```

URL (`*.localhost` resolve เป็น 127.0.0.1 เอง ไม่ต้องแก้ `/etc/hosts`):

- staging: http://staging.nest-lab.localhost:8080
- production: http://api.nest-lab.localhost:8080
- LB stats ("target group health"): http://localhost:8404

`make help` ดู target ทั้งหมด. หยุดชั่วคราว `make stop` / `make start`. ลบทิ้งทั้งหมด `make down` (ลบ volume + image ใน registry ด้วย)

> `KUBECONFIG` ชี้ไฟล์ในโปรเจกต์ ไม่แตะ `~/.kube/config` ของคุณ

## App endpoints

| Method | Path | ใช้ทำอะไรใน lab |
|---|---|---|
| GET | `/` | ข้อมูล app + pod/node ที่ตอบ (ดู load balancing) |
| GET | `/config` | เทียบค่าจาก ConfigMap แบบ env vs แบบ file mount + fingerprint ของ Secret |
| GET | `/health/live` | livenessProbe |
| GET | `/health/ready` | readinessProbe (ตอบ 503 ระหว่าง shutdown) |
| GET | `/chaos/cpu?ms=200` | เผา CPU ให้ HPA scale |
| POST | `/chaos/crash` | process exit 1 → ดู restart |
| POST | `/chaos/ready?state=false` | บังคับ pod not-ready → ดูหลุดจาก endpoints |

`/chaos/*` เปิดเฉพาะเมื่อ `CHAOS_ENABLED=true` (staging เปิด, production ปิด → 404)

## Config (env)

| Key | Default | หมายเหตุ |
|---|---|---|
| `PORT` | `3000` | |
| `APP_NAME`, `APP_ENV`, `GREETING` | | แสดงใน `/` |
| `LOG_LEVEL` | `log` | `fatal\|error\|warn\|log\|debug\|verbose` ค่าผิด → app ไม่ start |
| `LOG_FORMAT` | text | `json` = structured log สำหรับ log shipper |
| `SHUTDOWN_DELAY_MS` | `0` | หน่วงก่อนปิด server หลังได้ SIGTERM (k8s ตั้ง 5000) ค่าผิด → app ไม่ start |
| `CHAOS_ENABLED` | `false` | |
| `CONFIG_FILE_PATH` | `/etc/nest-lab/app-config.json` | อ่านใหม่ทุก request |
| `API_KEY` | | จาก Secret, แสดงแค่ fingerprint |
| `POD_NAME`, `POD_NAMESPACE`, `POD_IP`, `NODE_NAME` | | Downward API |

## พัฒนา app

```bash
npm ci
npm run start:dev
npm test && npm run test:e2e && npm run lint
```

## โครงสร้างไฟล์

```
compose.yaml              cluster: control-plane, 3 workers, lb, registry
cluster/                  haproxy.cfg, registries.yaml (mirror → registry)
Dockerfile                multi-stage, non-root UID 1000, prod deps only
k8s/base/                 Deployment, Service, Ingress, ConfigMaps, HPA, PDB, NetworkPolicy, SA
k8s/overlays/staging/     namespace nest-lab-staging, 2 replicas, chaos on, debug log
k8s/overlays/production/  namespace nest-lab-prod, 3 replicas, chaos off
k8s/lab/                  debug-client.yaml (shell pod), generator/ (configMapGenerator demo)
docs/kubernetes-101.html  เอกสารประกอบการสอน (เปิดใน browser ได้)
docs/k8s-workshop.html    workshop 90 นาทีสำหรับ junior
src/                      NestJS app
```
