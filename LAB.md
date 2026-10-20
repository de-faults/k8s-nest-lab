# Kubernetes Lab — kubectl, ConfigMap, และ production patterns แบบ EKS

ทุก lab สมมติว่าอยู่ที่ root ของโปรเจกต์ และ deploy ครบแล้ว:

```bash
make up && make image && make deploy && make deploy ENV=production
export KUBECONFIG=$PWD/.kube/kubeconfig.yaml
alias k=kubectl
S=nest-lab-staging   P=nest-lab-prod
STG=http://staging.nest-lab.localhost:8080
PRD=http://api.nest-lab.localhost:8080
```

แนะนำเปิด terminal ที่สองไว้ `watch`/`-w` ระหว่างทำ lab

---

## Lab 1 — สำรวจ cluster

```bash
k cluster-info
k get nodes -o wide
k get nodes -L topology.kubernetes.io/zone,node.kubernetes.io/instance-type
k describe node control-plane | grep -A2 Taints      # ทำไม app ไม่ลง node นี้
k get ns
k get pods -A -o wide                                # system pods: coredns, traefik, metrics-server
k api-resources | head -30
k explain deployment.spec.strategy.rollingUpdate     # ดู doc ของ field ใดก็ได้
k top nodes
```

**คำถาม:** pod ของ `kube-system` อยู่ node ไหนบ้าง? ทำไม `svclb-traefik-*` มีทุก worker? (ดู `k -n kube-system get ds`)

---

## Lab 2 — Workload พื้นฐาน

```bash
k -n $S get deploy,rs,pod,svc,ingress -o wide
k -n $P get pod -o wide                              # 3 pod กระจาย 3 zone (topologySpreadConstraints)
k -n $S describe deploy nest-lab                     # probes, resources, env, volumes
k -n $S get pod -l app.kubernetes.io/name=nest-lab -o custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,IP:.status.podIP
k -n $S get deploy nest-lab -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

# logs (JSON เพราะ LOG_FORMAT=json)
k -n $S logs deploy/nest-lab --tail=20
k -n $S logs -l app.kubernetes.io/name=nest-lab -f --prefix

# เรียก app 3 ทาง
curl -s $STG/ | jq                                   # 1) ผ่าน LB → Traefik → Service
k -n $S port-forward svc/nest-lab 3000:80            # 2) port-forward (terminal อื่น: curl localhost:3000/)
k -n $S apply -f k8s/lab/debug-client.yaml           # 3) จากใน cluster
k -n $S exec debug-client -- wget -qO- http://nest-lab/
k -n $S exec debug-client -- nslookup nest-lab.nest-lab-staging.svc.cluster.local

# เข้าไปใน container
k -n $S exec -it deploy/nest-lab -- sh
  id                       # uid=1000 ไม่ใช่ root
  touch /app/x             # Read-only file system — readOnlyRootFilesystem
  touch /tmp/x             # ได้ เพราะ mount emptyDir ไว้
  cat /etc/nest-lab/app-config.json
  env | sort | grep -E 'APP_|POD_|NODE_'
```

ยิง `curl -s $STG/ | jq -r .pod.name` หลาย ๆ ครั้ง — เห็น pod สลับกันตอบ

---

## Lab 3 — ConfigMap (หัวใจของ lab)

app มี ConfigMap 2 แบบ เปิด `/config` จะเห็นทั้งคู่:

| ConfigMap | เข้า container ทาง | แก้แล้วเห็นผลเมื่อ |
|---|---|---|
| `nest-lab-env` | `envFrom` (environment variable) | **ต้อง recreate pod** |
| `nest-lab-files` | volume mount เป็นไฟล์ | kubelet sync เอง ~ไม่เกิน 1 นาที **ไม่ต้อง restart** |

### 3.1 ดู

```bash
k -n $S get cm
k -n $S get cm nest-lab-env -o yaml
k -n $S describe cm nest-lab-files
k -n $S get cm nest-lab-env -o jsonpath='{.data.GREETING}{"\n"}'
diff <(k -n $S get cm nest-lab-env -o yaml) <(k -n $P get cm nest-lab-env -o yaml)   # staging vs prod
```

### 3.2 แก้ env ConfigMap → ไม่เปลี่ยนจนกว่า restart

```bash
k -n $S edit cm nest-lab-env                         # เปลี่ยน GREETING
# หรือ
k -n $S patch cm nest-lab-env --type merge -p '{"data":{"GREETING":"hi from patch"}}'

curl -s $STG/config | jq .fromEnv.GREETING           # ยังค่าเก่า!
k -n $S rollout restart deploy/nest-lab
k -n $S rollout status deploy/nest-lab
curl -s $STG/config | jq .fromEnv.GREETING           # ค่าใหม่
```

### 3.3 แก้ file ConfigMap → hot reload

```bash
k -n $S patch cm nest-lab-files --type merge \
  -p '{"data":{"app-config.json":"{\"banner\":\"hot reloaded\",\"rateLimitPerMinute\":1}"}}'

watch -n2 "curl -s $STG/config | jq .fromFile.data"   # รอ ~30-60 วิ เปลี่ยนเอง pod ไม่ restart
k -n $S get pod                                       # RESTARTS / AGE ไม่เปลี่ยน
k -n $S exec deploy/nest-lab -- ls -la /etc/nest-lab/ # เห็น symlink ..data → kubelet สลับแบบ atomic
```

> ⚠ ถ้า mount ด้วย `subPath` ไฟล์จะ **ไม่** update อัตโนมัติ

### 3.4 สร้าง ConfigMap ด้วย kubectl (imperative)

```bash
k -n $S create configmap demo --from-literal=A=1 --from-literal=B=two
echo '{"x":1}' > /tmp/demo.json
k -n $S create configmap demo-file --from-file=settings.json=/tmp/demo.json
printf 'K1=v1\nK2=v2\n' > /tmp/demo.env
k -n $S create configmap demo-env --from-env-file=/tmp/demo.env
k -n $S get cm demo demo-file demo-env -o yaml

# pattern ที่ใช้จริงใน CI: สร้าง YAML ไม่ส่งขึ้น cluster แล้ว apply (idempotent)
k -n $S create configmap demo --from-literal=A=2 --dry-run=client -o yaml | k apply -f -
```

### 3.5 Immutable ConfigMap

```bash
k -n $S patch cm demo -p '{"immutable":true}'
k -n $S patch cm demo --type merge -p '{"data":{"A":"3"}}'   # error: field is immutable
k -n $S delete cm demo demo-file demo-env                    # ลบแล้วสร้างใหม่เท่านั้น
```

ใช้จริงกับ config ที่ไม่ควรเปลี่ยนกลางทาง + ลดโหลด API server (kubelet ไม่ต้อง watch)

### 3.6 Config พัง → CrashLoopBackOff (และทำไม maxUnavailable: 0 ช่วยชีวิต)

```bash
k -n $S patch cm nest-lab-env --type merge -p '{"data":{"SHUTDOWN_DELAY_MS":"abc"}}'
k -n $S rollout restart deploy/nest-lab
k -n $S get pod -w                                   # pod ใหม่ CrashLoopBackOff, pod เก่ายัง Running
k -n $S logs <pod-ใหม่> --previous                    # Invalid SHUTDOWN_DELAY_MS="abc"
curl -s -o /dev/null -w '%{http_code}\n' $STG/       # 200 — ยังเสิร์ฟจาก pod เก่า
k -n $S rollout status deploy/nest-lab               # ค้าง → สุดท้าย "exceeded its progress deadline"

# แก้
k -n $S patch cm nest-lab-env --type merge -p '{"data":{"SHUTDOWN_DELAY_MS":"5000"}}'
k -n $S rollout restart deploy/nest-lab
```

**ข้อสังเกต:** `rollout undo` ไม่ช่วย เพราะ ConfigMap ไม่ได้ versioned ไปกับ Deployment → ดู 3.7

### 3.7 configMapGenerator — pattern production

ConfigMap ชื่อคงที่มีปัญหา 2 ข้อ: แก้แล้ว pod ไม่ restart และ rollback ไม่ได้ Kustomize แก้ด้วย `configMapGenerator` ที่ต่อ hash ท้ายชื่อ ดูตัวอย่างใน `k8s/lab/generator/kustomization.yaml` (staging + ConfigMap `nest-lab-extra` ที่ override `GREETING`)

```bash
k kustomize k8s/lab/generator | grep -n nest-lab-extra    # nest-lab-extra-<hash> ทั้งใน CM และใน Deployment
k apply -k k8s/lab/generator
k -n $S rollout status deploy/nest-lab
curl -s $STG/config | jq .fromEnv.GREETING               # "... v1"

# แก้ literal v1 → v2 ในไฟล์ แล้ว
k diff -k k8s/lab/generator                              # hash ใหม่ → pod template เปลี่ยน
k apply -k k8s/lab/generator                             # rollout เองโดยไม่ต้อง restart
k -n $S get cm | grep extra                              # CM เก่ายังอยู่ → rollback ได้
k -n $S rollout undo deploy/nest-lab                     # กลับไปใช้ config v1 จริง
```

ลองเสร็จแล้ว `make deploy` กลับ overlay ปกติ และลบ CM `nest-lab-extra-*` ทิ้ง (production ใช้ Argo CD prune จัดการ CM เก่า)

---

## Lab 4 — Secret

```bash
k -n $S get secret nest-lab-secret -o yaml           # data เป็น base64 — ไม่ใช่การเข้ารหัส!
k -n $S get secret nest-lab-secret -o jsonpath='{.data.API_KEY}' | base64 -d; echo
curl -s $STG/config | jq .secret                     # app โชว์แค่ fingerprint

# rotate
make secret API_KEY=new-rotated-key-123
k -n $S rollout restart deploy/nest-lab              # env จาก Secret ก็ต้อง restart เหมือน ConfigMap
curl -s $STG/config | jq .secret

# Secret หาย
k -n $S delete secret nest-lab-secret
k -n $S rollout restart deploy/nest-lab
k -n $S get pod                                      # CreateContainerConfigError
k -n $S describe pod <pod> | tail -5                 # secret "nest-lab-secret" not found
make secret                                          # กลับมาเอง ไม่ต้องทำอะไรต่อ
```

บน EKS จริง: เก็บใน AWS Secrets Manager แล้วใช้ External Secrets Operator sync มาเป็น Secret + เปิด KMS envelope encryption

---

## Lab 5 — Rolling update, zero downtime, rollback

```bash
# terminal 2: ยิงต่อเนื่อง นับ error
while true; do curl -s -o /dev/null -w '%{http_code} ' $STG/; sleep 0.1; done

# terminal 1: ออก version ใหม่
make image TAG=0.2.0
k -n $S set image deploy/nest-lab app=localhost:5001/nest-lab:0.2.0
k -n $S annotate deploy/nest-lab kubernetes.io/change-cause="bump to 0.2.0"
k -n $S rollout status deploy/nest-lab
k -n $S get rs                                       # RS เก่า scale เป็น 0 แต่ยังเก็บไว้ (revisionHistoryLimit)
curl -s $STG/ | jq .version                          # "0.2.0"
k -n $S logs -l app.kubernetes.io/name=nest-lab --prefix | grep SIGTERM   # draining for 5000ms

k -n $S rollout history deploy/nest-lab
k -n $S rollout undo deploy/nest-lab                 # กลับ 0.1.0
k -n $S rollout undo deploy/nest-lab --to-revision=<n>
k -n $S rollout pause / resume deploy/nest-lab
```

terminal 2 ควรเห็น `200` ล้วน ๆ เพราะ: `maxUnavailable: 0` + readinessProbe + app หน่วง `SHUTDOWN_DELAY_MS` ก่อนปิด (endpoint ถูกถอดพร้อมกับที่ pod ได้ SIGTERM ไม่ใช่ก่อน)

**ทดลอง:** ตั้ง `SHUTDOWN_DELAY_MS: "0"` แล้ว rollout ใหม่ขณะยิงหนัก ๆ — มีโอกาสเห็น error

**แบบ GitOps:** แทนที่ `set image` ให้แก้ `newTag` ใน `k8s/overlays/staging/kustomization.yaml` แล้ว `k diff -k ...` → `make deploy` (ไม่งั้นรอบหน้า `make deploy` จะ revert กลับ tag ใน git)

---

## Lab 6 — Self-healing และ probes

```bash
# ลบ pod → ReplicaSet สร้างใหม่
k -n $S delete pod <pod>
k -n $S get pod -w

# process ตาย → container restart (RESTARTS +1)
curl -s -X POST $STG/chaos/crash
k -n $S get pod                                      # ดู RESTARTS
k -n $S logs <pod> --previous | tail -3

# readiness fail → หลุดจาก Service แต่ไม่ถูก restart
curl -s -X POST "$STG/chaos/ready?state=false"       # โดน pod ไหนดูจาก response
k -n $S get pod                                      # READY 0/1
k -n $S get endpointslices -l kubernetes.io/service-name=nest-lab -o yaml | grep -B2 -A2 'ready:'
k -n $S describe pod <pod> | grep -i readiness
for i in $(seq 10); do curl -s $STG/ | jq -r .pod.name; done   # ไม่มีชื่อ pod นั้นแล้ว

# เอากลับ: เข้าทาง LB ไม่ได้แล้ว ต้อง port-forward ตรงเข้า pod
k -n $S port-forward pod/<pod> 3001:3000 &
curl -s -X POST "localhost:3001/chaos/ready?state=true"; kill %1
```

`k -n $P` ลอง `curl -X POST $PRD/chaos/crash` → 404 เพราะ prod ปิด chaos

---

## Lab 7 — NetworkPolicy

namespace มี default-deny ingress, อนุญาตเฉพาะ Traefik และ pod ที่มี label `nest-lab-client=true`

```bash
k -n $S get netpol
k -n $S describe netpol nest-lab-allow

k -n $S exec debug-client -- wget -qO- -T3 http://nest-lab/health/ready      # OK
k -n $S label pod debug-client nest-lab-client-                              # ถอด label
k -n $S exec debug-client -- wget -qO- -T3 http://nest-lab/health/ready      # ถูกปฏิเสธ
k -n $S label pod debug-client nest-lab-client=true
```

**โจทย์:** สร้าง pod ใน namespace `default` แล้วลองเรียก `nest-lab.nest-lab-staging` — ทำไมไม่ได้? แก้ policy ให้ namespace นั้นเข้าได้ (ใช้ `namespaceSelector`)

---

## Lab 8 — HPA (autoscale ตาม CPU)

```bash
k -n $S get hpa -w                                   # terminal 2
k -n $S top pod                                      # terminal 3 (watch)

# terminal 1: สร้างโหลด (Ctrl-C หยุด)
seq 100000 | xargs -P8 -I{} curl -s -o /dev/null "$STG/chaos/cpu?ms=500"
```

ภายใน 1–2 นาที replicas 2 → 6 (max ของ staging). หยุดโหลดแล้วรอ ~1–2 นาทีจะ scale ลง (`behavior.scaleDown.stabilizationWindowSeconds: 60`)

```bash
k -n $S describe hpa nest-lab                        # events: New size ... reason
```

**ข้อสังเกต:** % CPU คิดจาก `requests.cpu` (100m) ไม่ใช่ limit — ตั้ง request ผิด HPA ก็เพี้ยน. บน EKS ถ้า pod ล้น node → Karpenter/Cluster Autoscaler เพิ่ม node

---

## Lab 9 — Node maintenance (drain + PDB)

จำลอง managed node group upgrade:

```bash
k -n $P get pod -o wide -w                           # terminal 2
k cordon worker-1a                                   # ห้าม schedule ใหม่
k get nodes                                          # SchedulingDisabled
k drain worker-1a --ignore-daemonsets --delete-emptydir-data
k -n $P get pdb                                      # ALLOWED DISRUPTIONS
k uncordon worker-1a
```

**ทดลอง:** ตั้ง PDB เป็น `maxUnavailable: 0` แล้ว drain — ค้าง (`Cannot evict pod as it would violate the pod's disruption budget`) นี่คือสาเหตุยอดฮิตที่ EKS node upgrade ไม่จบ

---

## Lab 10 — AZ ล่ม

```bash
# terminal 2
while true; do curl -s -m2 -o /dev/null -w '%{http_code} ' $PRD/; sleep 0.2; done
# terminal 3
k get nodes -w

docker compose stop worker-1b                        # ทั้ง "AZ" 1b หายไป
```

สิ่งที่จะเห็น:
1. http://localhost:8404 — LB ถอด worker-1b ใน ~4 วิ
2. ช่วง ~40–60 วิแรก: error บางส่วน — Traefik ยังส่งไป pod IP บน node ที่ตาย จนกว่า node จะถูก mark `NotReady`
3. node `NotReady` → 30 วิ (`tolerationSeconds: 30` ใน Deployment, default จริง 300) → pod ถูก evict แล้วสร้างใหม่ใน zone ที่เหลือ

```bash
docker compose start worker-1b
k -n $P get pod -o wide                              # pod ไม่ย้ายกลับเอง! zone ไม่ balance
k -n $P rollout restart deploy/nest-lab              # rebalance (production ใช้ descheduler)
```

บน AWS: ALB target group health check + pod readiness gate (`elbv2.k8s.aws/pod-readiness-gate-inject`) ลดช่วง error ข้อ 2

---

## Lab 11 — RBAC

```bash
k -n $S create serviceaccount viewer
k -n $S create rolebinding viewer --clusterrole=view --serviceaccount=$S:viewer
k auth can-i list pods     -n $S --as=system:serviceaccount:$S:viewer   # yes
k auth can-i get secrets   -n $S --as=system:serviceaccount:$S:viewer   # no  (view ไม่ให้อ่าน secret)
k auth can-i delete pods   -n $S --as=system:serviceaccount:$S:viewer   # no
k auth can-i list pods     -n $P --as=system:serviceaccount:$S:viewer   # no  (RoleBinding ผูก namespace)
k auth can-i --list -n $S  --as=system:serviceaccount:$S:viewer
```

บน EKS: map IAM role → Kubernetes group ผ่าน EKS access entries แล้ว bind ด้วย RBAC แบบเดียวกันนี้

---

## Lab 12 — โจทย์ท้าทาย

1. เพิ่ม key `MAINTENANCE_MESSAGE` ใน `nest-lab-env` แล้วให้ app แสดงใน `/` (แก้ `src/app-config.ts`) → build `0.3.0` → deploy
2. ทำให้ ConfigMap env ใหม่ rollout อัตโนมัติโดยไม่ใช้ generator (hint: annotation checksum บน pod template)
3. เพิ่ม `ResourceQuota` + `LimitRange` ให้ namespace staging แล้วดูว่า HPA scale เกิน quota ได้ไหม
4. ทำ blue/green ด้วย 2 Deployment + สลับ `selector` ของ Service
5. ใช้ `k -n $S debug -it <pod> --image=busybox:1.37 --target=app` (ephemeral container) ดู process ของ app

---

## Cleanup

```bash
make undeploy                  # ลบ staging ทั้ง namespace
make undeploy ENV=production
make stop                      # พัก cluster ไว้ใช้ต่อ
make down                      # ลบทุกอย่างรวม volume
```

## Troubleshooting

| อาการ | แก้ |
|---|---|
| `make up` port 6443/8080/5001 ชน | ปิดโปรแกรมที่ใช้ port หรือ `LB_HTTP_PORT=9080 make up` (แล้วใช้ `make smoke LB_PORT=9080`) |
| `ErrImagePull` | ยังไม่ `make image` หรือ tag ใน overlay ไม่ตรงกับที่ push (`curl localhost:5001/v2/nest-lab/tags/list`) |
| Mac sleep แล้ว cluster แปลก ๆ (`Unauthorized`, rollout timeout) | `make stop && make start` |
| อยากเริ่มใหม่หมด | `make down && make up && make image && make deploy` |
