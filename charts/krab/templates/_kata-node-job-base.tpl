{{/* Generated from https://github.com/kata-containers/kata-containers/blob/03cf2ec06a5d302f23af811744f6bcea49988bfb/tools/packaging/kata-deploy/helm-chart/kata-deploy/templates/_helpers.tpl; do not edit. */}}
{{- define "krab.kata.perNodeJobBase" -}}
{{- $root := .root -}}
{{- $stage := .stage -}}
{{- $rootless := include "kata-deploy.getRootlessShims" $root | trim -}}
{{- /* The dispatcher polls each Job for its result. A Job deleted before the next
       poll leaves its node with no result, and that counts as a failure. */}}
{{- if lt (int $root.Values.job.ttlSecondsAfterFinished) 60 -}}
{{- fail (printf "job.ttlSecondsAfterFinished is %v, which is too short for the dispatcher to observe a per-node Job finishing: the Job is deleted before it is next polled and its node is reported as failed even though its install succeeded. Use 60 or more." $root.Values.job.ttlSecondsAfterFinished) -}}
{{- end -}}
apiVersion: batch/v1
kind: Job
metadata:
  labels:
    app.kubernetes.io/name: {{ include "kata-deploy.name" $root }}
    app.kubernetes.io/instance: {{ $root.Release.Name }}
    kata-deploy/stage: {{ $stage }}
spec:
  backoffLimit: {{ $root.Values.job.backoffLimit }}
  ttlSecondsAfterFinished: {{ $root.Values.job.ttlSecondsAfterFinished }}
  {{- /* The dispatcher waits for every node it dispatched to. Without a deadline,
         one stuck pod would hold up the whole rollout. */}}
  activeDeadlineSeconds: {{ $root.Values.job.activeDeadlineSeconds | default 3600 }}
  template:
    metadata:
      labels:
{{- with $root.Values.podLabels }}
{{- toYaml . | nindent 8 }}
{{- end }}
        app.kubernetes.io/name: {{ include "kata-deploy.name" $root }}
        app.kubernetes.io/instance: {{ $root.Release.Name }}
        kata-deploy/stage: {{ $stage }}
{{- $podAnnotations := include "kata-deploy.podTemplateAnnotations" $root | trim }}
{{- if $podAnnotations }}
      annotations:
{{- $podAnnotations | nindent 8 }}
{{- end }}
    spec:
{{- with $root.Values.imagePullSecrets }}
      imagePullSecrets:
{{- toYaml . | nindent 8 }}
{{- end }}
      {{- /* Without this, Kubernetes mounts the namespace's default token. These
             pods need no API access: the dispatcher does all of it. */}}
      automountServiceAccountToken: false
      restartPolicy: Never
{{- if eq $stage "cleanup" }}
      {{- /* nodeName gets the pod past the scheduler, but not past the taint
             manager, which evicts even a bound pod. A node tainted after the
             install would keep its Kata configuration for good. */}}
      tolerations:
        - operator: Exists
{{- else }}
      {{- /* The DaemonSet controller adds these to its own pods, and job mode
             installs on the same nodes. not-ready matters most: this Job
             restarts the CRI runtime, which takes the node NotReady long enough
             for the taint manager to evict it mid-install. */}}
      tolerations:
{{- if $root.Values.job.nodes }}
        {{- /* Explicit names are a deliberate admission override. nodeName gets
               past the scheduler, but an untolerated NoExecute taint can still
               evict the bound pod before it finishes. */}}
        - operator: Exists
{{- else }}
        - key: node.kubernetes.io/not-ready
          operator: Exists
          effect: NoExecute
        - key: node.kubernetes.io/unreachable
          operator: Exists
          effect: NoExecute
        - key: node.kubernetes.io/disk-pressure
          operator: Exists
          effect: NoSchedule
        - key: node.kubernetes.io/memory-pressure
          operator: Exists
          effect: NoSchedule
        - key: node.kubernetes.io/pid-pressure
          operator: Exists
          effect: NoSchedule
        - key: node.kubernetes.io/unschedulable
          operator: Exists
          effect: NoSchedule
{{- end }}
{{- with $root.Values.tolerations }}
{{- toYaml . | nindent 8 }}
{{- end }}
{{- end }}
{{- with $root.Values.priorityClassName }}
      priorityClassName: {{ . | quote }}
{{- end }}
{{- if eq $stage "install" }}
      initContainers:
{{- /* First of all: a stage asking for a domain the node lacks cannot start. */}}
{{- if include "kata-deploy.selinuxEnabled" $root | trim }}
{{- include "kata-deploy.stageContainer" (dict "root" $root "name" "selinux-policy" "action" "install-stage-selinux-policy" "privileged" true "mountHost" true "mountHostRoot" true "hostRootWritable" true) | nindent 8 }}
{{- end }}
{{- /* All before the host check, so it validates the binaries being installed
       rather than the versions they are there to replace. One staging container
       per nodeBinaries entry, so a new entry is a values change only. */}}
{{- $nodeBinaries := include "kata-deploy.nodeBinaries" $root | fromYaml }}
{{- range $name, $spec := $nodeBinaries }}
{{- include "kata-deploy.nodeBinariesStageContainer" (dict "root" $root "name" $name "spec" $spec) | nindent 8 }}
{{- end }}
{{- if $nodeBinaries }}
{{- include "kata-deploy.nodeBinariesInstallContainer" (dict "root" $root "name" "node-binaries-install" "staged" true) | nindent 8 }}
{{- end }}
{{- /* Privileged, and holding the host root, because it runs the host's own modprobe. */}}
{{- include "kata-deploy.stageContainer" (dict "root" $root "name" "load-kernel-modules" "action" "install-stage-load-kernel-modules" "privileged" true "mountHost" true "mountHostRoot" true "mountModulesLoad" true) | nindent 8 }}
{{- include "kata-deploy.stageContainer" (dict "root" $root "name" "host-check" "action" "install-stage-host-check" "privileged" false "mountHost" true "selinuxDomain" "kata_deploy_check_t") | nindent 8 }}
{{- if $rootless }}
{{- /* Run after validation because this stage changes persistent host state. */}}
{{- include "kata-deploy.stageContainer" (dict "root" $root "name" "rootless-devices" "action" "install-stage-rootless-devices" "privileged" true "mountHost" true "mountHostRoot" true "hostRootWritable" true "mountHostDev" true "mountUdevRules" true) | nindent 8 }}
{{- end }}
{{- include "kata-deploy.stageContainer" (dict "root" $root "name" "artifacts" "action" "install-stage-artifacts" "privileged" false "mountHost" true "mountUdevRules" true "selinuxDomain" "kata_deploy_artifacts_t") | nindent 8 }}
      containers:
{{- include "kata-deploy.stageContainer" (dict "root" $root "name" "cri" "action" "install-stage-cri" "privileged" false "mountHost" true "selinuxDomain" "kata_deploy_cri_t") | nindent 8 }}
{{- else }}
      initContainers:
{{- /* Here too, since these stages are confined as well: a node whose module went
       missing could otherwise never be uninstalled. Re-loading it is idempotent. */}}
{{- if include "kata-deploy.selinuxEnabled" $root | trim }}
{{- include "kata-deploy.stageContainer" (dict "root" $root "name" "selinux-policy" "action" "install-stage-selinux-policy" "privileged" true "mountHost" true "mountHostRoot" true "hostRootWritable" true) | nindent 8 }}
{{- end }}
{{- include "kata-deploy.stageContainer" (dict "root" $root "name" "revert-cri" "action" "cleanup-stage-revert-cri" "privileged" false "mountHost" true "selinuxDomain" "kata_deploy_cri_t") | nindent 8 }}
{{- /* After the revert, so containerd is no longer converting layers with them.
       Unconditional, and driven by the marker alone, so that an uninstall tidies
       up even when the entries were dropped from the values first. */}}
{{- include "kata-deploy.nodeBinariesInstallContainer" (dict "root" $root "name" "node-binaries-remove") | nindent 8 }}
      containers:
{{- include "kata-deploy.stageContainer" (dict "root" $root "name" "remove-artifacts" "action" "cleanup-stage-remove-artifacts" "privileged" false "mountHost" true "mountModulesLoad" true "mountUdevRules" true "selinuxDomain" "kata_deploy_artifacts_t") | nindent 8 }}
{{- end }}
      volumes:
{{- include "kata-deploy.commonVolumes" $root | nindent 8 }}
        - name: modules-load-d
          hostPath:
            path: /etc/modules-load.d
            type: DirectoryOrCreate
{{- /* Unconditional, as modules-load-d: a rule written while rootless was on has
       to be removable once it is off, when the stage that wrote it no longer runs. */}}
        - name: udev-rules-d
          hostPath:
            path: /etc/udev/rules.d
            type: DirectoryOrCreate
{{- /* The cleanup pipeline holds the host root for the policy stage alone. */}}
{{- if or (eq $stage "install") (include "kata-deploy.selinuxEnabled" $root | trim) }}
        - name: host-root
          hostPath:
            path: /
            type: Directory
{{- if and (eq $stage "install") $rootless }}
        - name: host-dev
          hostPath:
            path: /dev
            type: Directory
{{- end }}
{{- end }}
{{- if and (eq $stage "install") (include "kata-deploy.nodeBinaries" $root | fromYaml) }}
        {{- /* Pod-local, so those images reach nothing of the node's. */}}
        - name: node-binaries
          emptyDir: {}
{{- end }}
{{- end -}}
