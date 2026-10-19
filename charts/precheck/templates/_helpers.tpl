{{- define "krab-precheck.name" -}}
{{- printf "%s" .Release.Name | trunc 45 | trimSuffix "-" -}}
{{- end -}}

{{- define "krab-precheck.nodeSelector" -}}
{{- if .Values.nodeSelector -}}
{{- printf "%s,kubernetes.io/os=linux" .Values.nodeSelector -}}
{{- else -}}
kubernetes.io/os=linux
{{- end -}}
{{- end -}}
