---
name: k8s-cleanup-unused-resources
description: Cleans up unused ConfigMaps and Secrets in a Kubernetes namespace that end with a hyphen and an alphanumeric suffix (e.g., 'resource-name-abc123'). This is specifically designed to target and remove stale resources created by Kustomize's `configMapGenerator` and `secretGenerator`, which append unique suffixes to resource names to trigger rolling updates.
---

# K8s Cleanup Unused Resources

This skill identifies and deletes ConfigMaps and Secrets in a specified namespace that match the pattern `*-<suffix>` (where suffix is alphanumeric) and are not currently referenced by any other Kubernetes resources.

The primary purpose of this skill is to clean up "orphaned" resources left behind by Kustomize. When Kustomize generates ConfigMaps or Secrets, it appends a random suffix to the name; when the configuration changes, a new resource is created with a *new* suffix, leaving the old one behind. This skill automates the removal of those previous, unreferenced generations.

## Usage

To run a dry run (see what would be deleted without actually deleting anything):
```bash
/skill:k8s-cleanup-unused-resources --namespace <namespace> --dry-run
```

To actually perform the cleanup:
```bash
/skill:k8s-cleanup-unused-resources --namespace <namespace>
```

## Requirements

- `kubectl` must be configured and have access to the cluster.
- `node` (v16+) must be installed.
