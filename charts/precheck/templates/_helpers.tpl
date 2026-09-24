{{- define "krab-precheck.name" -}}
{{- printf "%s" .Release.Name | trunc 45 | trimSuffix "-" -}}
{{- end -}}
