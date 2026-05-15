---
name: k8s-cleanup-unused-resources
description: Identifies unused ConfigMaps and Secrets in a Kubernetes namespace that end with a hyphen and an alphanumeric suffix (e.g., 'resource-name-abc123'). This is specifically designed to target stale resources created by Kustomize's `configMapGenerator` and `secretGenerator`, which append unique suffixes to resource names to trigger rolling updates.
---

# K8s Cleanup Unused Resources

This skill identifies ConfigMaps and Secrets in a specified namespace that match the pattern `*-<suffix>` (where suffix is alphanumeric) and are not currently referenced by any other Kubernetes resources.

The primary purpose is to clean up "orphaned" resources left behind by Kustomize. When Kustomize generates ConfigMaps or Secrets, it appends a random suffix to the name; when the configuration changes, a new resource is created with a *new* suffix, leaving the old one behind.

## Usage

```bash
/skill:k8s-cleanup-unused-resources --namespace <namespace>
```

## What to do next

The script outputs `kubectl delete` commands for each verified unused resource. After running the skill:

1. Review the listed commands
2. Use your `bash` tool to execute them, or execute them manually

The script performs two layers of verification:
- **Reference check**: Scans pods, deployments, daemonsets, statefulsets, replicasets, serviceaccounts, ingresses, and podtemplates to ensure the resource isn't referenced anywhere
- **Kustomize hash verification**: Confirms the suffix matches Kustomize's actual SHA256-based encoding, preventing false positives from legitimately suffixed resources

## Requirements

- `kubectl` must be configured and have access to the cluster.
- `node` (v16+) must be installed.
