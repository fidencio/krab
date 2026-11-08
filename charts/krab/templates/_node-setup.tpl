{{/*
Extend the pinned Kata pipeline between artifact installation and CRI setup.
The dispatcher advertises the node only after this stage also succeeds.
Cleanup removes KRAB's host service before Kata artifacts disappear.
*/}}
{{- define "kata-deploy.perNodeJob" -}}
{{- $root := .root -}}
{{- $job := include "krab.kata.perNodeJobBase" . | fromYaml -}}
{{- $pod := $job.spec.template.spec -}}
{{- $settings := $root.Values.global.krab -}}
{{- $args := list "prepare-node" "--host-root" "/host" "--owner" (printf "%s/%s" $root.Release.Namespace $root.Release.Name) -}}
{{- if eq .stage "cleanup" -}}
  {{- $args = append $args "--remove" -}}
{{- else -}}
  {{- if $settings.continuousConformance -}}
    {{- $args = append $args "--continuous-conformance" -}}
    {{- $args = concat $args (list "--deployment-policy" (toJson $settings.conformancePolicy)) -}}
  {{- end -}}
  {{- range $tee := $settings.nvidiaCpuTees -}}
    {{- $args = concat $args (list "--cpu-tee" $tee) -}}
  {{- end -}}
{{- end -}}
{{- $prefix := default "" $root.Values.env.installationPrefix -}}
{{- $directory := printf "%s/opt/kata" $prefix -}}
{{- with $root.Values.env.multiInstallSuffix -}}
  {{- $directory = printf "%s-%s" $directory . -}}
{{- end -}}
{{- $args = concat $args (list "--install-dir" $directory) -}}
{{- $container := dict "name" "krab-node-setup" "image" $settings.nodeImage "command" (list "/usr/local/bin/krab-preflight") "args" $args "securityContext" (dict "privileged" true) "volumeMounts" (list (dict "name" "krab-host-root" "mountPath" "/host") (dict "name" "krab-host-proc" "mountPath" "/host/proc" "readOnly" true)) -}}
{{- if eq .stage "cleanup" -}}
  {{- $_ := set $pod "initContainers" (prepend $pod.initContainers $container) -}}
{{- else -}}
  {{- $_ := set $pod "initContainers" (append $pod.initContainers $container) -}}
{{- end -}}
{{- $_ := set $pod "hostPID" true -}}
{{- $_ := set $pod "volumes" (concat $pod.volumes (list (dict "name" "krab-host-root" "hostPath" (dict "path" "/" "type" "Directory")) (dict "name" "krab-host-proc" "hostPath" (dict "path" "/proc" "type" "Directory")))) -}}
{{- toYaml $job -}}
{{- end -}}
