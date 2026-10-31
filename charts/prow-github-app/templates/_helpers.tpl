{{- define "prow-github-app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "prow-github-app.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "prow-github-app.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "prow-github-app.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "prow-github-app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "prow-github-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* the Deployment's pods only: the CronJob's pods share the selector labels and must not match it, the Service or the PDB */}}
{{- define "prow-github-app.serverSelectorLabels" -}}
{{ include "prow-github-app.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "prow-github-app.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "prow-github-app.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "prow-github-app.secretName" -}}
{{- default (include "prow-github-app.fullname" .) .Values.github.existingSecret -}}
{{- end -}}

{{- define "prow-github-app.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{/* true when several replicas share state through Redis; the schema already requires a source when replicaCount > 1 */}}
{{- define "prow-github-app.redisConfigured" -}}
{{- if or .Values.redis.url .Values.redis.existingSecret -}}true{{- end -}}
{{- end -}}

{{/* the env block both the Deployment and the CronJob use */}}
{{- define "prow-github-app.env" -}}
- name: GITHUB_APP_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "prow-github-app.secretName" . }}
      key: appId
- name: GITHUB_APP_PRIVATE_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "prow-github-app.secretName" . }}
      key: privateKey
- name: GITHUB_WEBHOOK_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "prow-github-app.secretName" . }}
      key: webhookSecret
{{- if .Values.redis.existingSecret }}
- name: REDIS_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.redis.existingSecret }}
      key: {{ .Values.redis.existingSecretKey }}
{{- else if .Values.redis.url }}
- name: REDIS_URL
  value: {{ .Values.redis.url | quote }}
{{- end }}
- name: PROW_REPLICAS
  value: {{ .Values.replicaCount | quote }}
{{- /* the pod's grace less the 5 s preStop sleep, the 5 s drain and 5 s to close the stores */}}
- name: PROW_SHUTDOWN_GRACE_MS
  value: {{ sub (mul .Values.terminationGracePeriodSeconds 1000) 15000 | quote }}
{{- range .Values.extraEnv }}
- {{ toYaml . | nindent 2 | trim }}
{{- end }}
{{- end -}}
