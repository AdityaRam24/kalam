{{- define "trinetra.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "trinetra.fullname" -}}
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

{{- define "trinetra.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "trinetra.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "trinetra.selectorLabels" -}}
app.kubernetes.io/name: {{ include "trinetra.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "trinetra.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "trinetra.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* repository[:tag][@digest] */}}
{{- define "trinetra.image" -}}
{{- $ref := printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- if .Values.image.digest -}}
{{- $ref = printf "%s@%s" $ref .Values.image.digest -}}
{{- end -}}
{{- $ref -}}
{{- end -}}

{{/* "true" when the PCAI VirtualService should be rendered: Istio is present
     and the endpoint is a real hostname. An unsubstituted ${DOMAIN_NAME}
     would be rejected by istiod's validation webhook and fail the install. */}}
{{- define "trinetra.pcaiEnabled" -}}
{{- $ez := .Values.ezua -}}
{{- if and $ez.enabled $ez.virtualService.endpoint (not (contains "${" $ez.virtualService.endpoint)) (or (.Capabilities.APIVersions.Has "networking.istio.io/v1beta1") (.Capabilities.APIVersions.Has "networking.istio.io/v1")) -}}
true
{{- end -}}
{{- end -}}

{{/* Browser origins the API accepts. Falls back to the hostnames this chart
     publishes, so a standard install never has to set it twice. */}}
{{- define "trinetra.allowedHosts" -}}
{{- if .Values.config.allowedHosts -}}
{{- .Values.config.allowedHosts -}}
{{- else -}}
{{- $hosts := list -}}
{{- if include "trinetra.pcaiEnabled" . -}}
{{- $hosts = append $hosts .Values.ezua.virtualService.endpoint -}}
{{- end -}}
{{- if .Values.ingress.enabled -}}
{{- $hosts = append $hosts .Values.ingress.host -}}
{{- end -}}
{{- join "," $hosts -}}
{{- end -}}
{{- end -}}

{{- define "trinetra.secretName" -}}
{{- if .Values.llm.existingSecret -}}
{{- .Values.llm.existingSecret -}}
{{- else -}}
{{- printf "%s-llm" (include "trinetra.fullname" .) -}}
{{- end -}}
{{- end -}}
