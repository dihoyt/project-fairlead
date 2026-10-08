// ntfy publishes no manifest of its own. The deploy module adds the Ingress
// for the chosen host in front of Service ntfy, port 80.
export const NTFY_VERSION = "v2.29.0";

export const ntfyManifest = `apiVersion: v1
kind: Namespace
metadata:
  name: ntfy
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ntfy-cache
  namespace: ntfy
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: ntfy
  namespace: ntfy
data:
  server.yml: |
    listen-http: ":80"
    cache-file: /var/cache/ntfy/cache.db
    attachment-cache-dir: /var/cache/ntfy/attachments
    behind-proxy: true
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ntfy
  namespace: ntfy
  labels:
    app.kubernetes.io/name: ntfy
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app.kubernetes.io/name: ntfy
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ntfy
    spec:
      containers:
        - name: ntfy
          image: docker.io/binwiederhier/ntfy:${NTFY_VERSION}
          args: [serve]
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet:
              path: /v1/health
              port: http
          resources:
            requests:
              cpu: 10m
              memory: 32Mi
            limits:
              memory: 256Mi
          volumeMounts:
            - name: config
              mountPath: /etc/ntfy
              readOnly: true
            - name: cache
              mountPath: /var/cache/ntfy
      volumes:
        - name: config
          configMap:
            name: ntfy
        - name: cache
          persistentVolumeClaim:
            claimName: ntfy-cache
---
apiVersion: v1
kind: Service
metadata:
  name: ntfy
  namespace: ntfy
  labels:
    app.kubernetes.io/name: ntfy
spec:
  selector:
    app.kubernetes.io/name: ntfy
  ports:
    - name: http
      port: 80
      targetPort: http
`;
