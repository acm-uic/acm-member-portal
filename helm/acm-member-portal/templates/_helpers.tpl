{{/*
Expand the name of the chart.
*/}}
{{- define "acm-member-portal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "acm-member-portal.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label (name-version).
*/}}
{{- define "acm-member-portal.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "acm-member-portal.labels" -}}
helm.sh/chart: {{ include "acm-member-portal.chart" . }}
{{ include "acm-member-portal.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "acm-member-portal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "acm-member-portal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Container image reference.
*/}}
{{- define "acm-member-portal.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | toString) }}
{{- end }}

{{/*
Public origin (ORIGIN / BETTER_AUTH_URL).
*/}}
{{- define "acm-member-portal.origin" -}}
{{- if .Values.origin }}
{{- .Values.origin }}
{{- else if .Values.ingress.host }}
{{- printf "https://%s" .Values.ingress.host }}
{{- else }}
{{- fail "Set origin or ingress.host" }}
{{- end }}
{{- end }}

{{/*
Application Secret name (Entra / SMTP / Windows API).
*/}}
{{- define "acm-member-portal.secretName" -}}
{{- if .Values.secret.create }}
{{- printf "%s-secrets" (include "acm-member-portal.fullname" .) }}
{{- else if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else }}
{{- fail "Set existingSecret or secret.create=true" }}
{{- end }}
{{- end }}

{{/*
True when the chart should write a Secret that holds DATABASE_URL.
*/}}
{{- define "acm-member-portal.createDatabaseSecret" -}}
{{- if .Values.database.enabled -}}
false
{{- else if and .Values.database.existingSecret .Values.database.existingSecretUrlKey -}}
false
{{- else if or .Values.database.url (and .Values.database.host .Values.database.password) -}}
true
{{- else -}}
false
{{- end -}}
{{- end }}

{{/*
Secret that holds DATABASE_URL (or CNPG uri).
*/}}
{{- define "acm-member-portal.databaseSecretName" -}}
{{- if .Values.database.enabled }}
{{- printf "%s-app" .Values.database.clusterName }}
{{- else if and .Values.database.existingSecret .Values.database.existingSecretUrlKey }}
{{- .Values.database.existingSecret }}
{{- else if eq (include "acm-member-portal.createDatabaseSecret" .) "true" }}
{{- printf "%s-database-url" (include "acm-member-portal.fullname" .) }}
{{- else }}
{{- fail "Set database.enabled=true or provide an external database (database.url, database.host+password, or database.existingSecret + existingSecretUrlKey)" }}
{{- end }}
{{- end }}

{{/*
Key inside the database Secret.
*/}}
{{- define "acm-member-portal.databaseSecretKey" -}}
{{- if .Values.database.enabled -}}
uri
{{- else if and .Values.database.existingSecret .Values.database.existingSecretUrlKey -}}
{{- .Values.database.existingSecretUrlKey -}}
{{- else -}}
DATABASE_URL
{{- end -}}
{{- end }}

{{/*
DATABASE_URL env var from the database Secret.
*/}}
{{- define "acm-member-portal.databaseUrlEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "acm-member-portal.databaseSecretName" . }}
      key: {{ include "acm-member-portal.databaseSecretKey" . }}
{{- end }}

{{/*
Shared envFrom + extra env for portal, worker, and cronjob.
*/}}
{{- define "acm-member-portal.envFrom" -}}
envFrom:
  - secretRef:
      name: {{ include "acm-member-portal.secretName" . }}
{{- with .Values.extraEnvFrom }}
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end }}

{{/*
Built postgres:// URL for an external database.
*/}}
{{- define "acm-member-portal.externalDatabaseUrl" -}}
{{- if .Values.database.url }}
{{- .Values.database.url }}
{{- else }}
{{- $user := .Values.database.user | default .Values.database.owner }}
{{- $pass := .Values.database.password | urlquery }}
{{- $host := .Values.database.host }}
{{- $port := int (.Values.database.port | default 5432) }}
{{- $db := .Values.database.database }}
{{- printf "postgres://%s:%s@%s:%d/%s" $user $pass $host $port $db }}
{{- end }}
{{- end }}

{{/*
Fail fast on contradictory database settings.
*/}}
{{- define "acm-member-portal.validate" -}}
{{- if not .Values.database.enabled }}
{{- $hasUrl := .Values.database.url }}
{{- $hasSecretUrl := and .Values.database.existingSecret .Values.database.existingSecretUrlKey }}
{{- $hasPassword := and .Values.database.host .Values.database.password }}
{{- if not (or $hasUrl $hasSecretUrl $hasPassword) }}
{{- fail "Set database.enabled=true or provide an external database (database.url, database.host+password, or database.existingSecret + existingSecretUrlKey)" }}
{{- end }}
{{- end }}
{{- if and .Values.secret.create (not .Values.secret.betterAuthSecret) }}
{{- fail "secret.create=true requires secret.betterAuthSecret" }}
{{- end }}
{{- end }}
