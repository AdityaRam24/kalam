{{- define "kalam.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "kalam.fullname" -}}
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

{{- define "kalam.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "kalam.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "kalam.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kalam.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "kalam.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "kalam.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Browser origins the API accepts. Falls back to the ingress host so a
     standard install is reachable without having to set it twice. */}}
{{- define "kalam.allowedHosts" -}}
{{- if .Values.config.allowedHosts -}}
{{- .Values.config.allowedHosts -}}
{{- else if .Values.ingress.enabled -}}
{{- .Values.ingress.host -}}
{{- end -}}
{{- end -}}

{{- define "kalam.secretName" -}}
{{- if .Values.llm.existingSecret -}}
{{- .Values.llm.existingSecret -}}
{{- else -}}
{{- printf "%s-llm" (include "kalam.fullname" .) -}}
{{- end -}}
{{- end -}}
