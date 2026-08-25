import { K8sModel } from '@openshift-console/dynamic-plugin-sdk';

export const ConfigMapModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  abbr: 'CM',
  label: 'ConfigMap',
  labelPlural: 'ConfigMaps',
  plural: 'configmaps',
  namespaced: true,
};

export const NamespaceModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'Namespace',
  abbr: 'NS',
  label: 'Namespace',
  labelPlural: 'Namespaces',
  plural: 'namespaces',
  namespaced: false,
};

export const ConsoleOperatorModel: K8sModel = {
  apiGroup: 'operator.openshift.io',
  apiVersion: 'v1',
  kind: 'Console',
  abbr: 'CO',
  label: 'Console',
  labelPlural: 'Consoles',
  plural: 'consoles',
  namespaced: false,
};

export const ConsolePluginModel: K8sModel = {
  apiGroup: 'console.openshift.io',
  apiVersion: 'v1',
  kind: 'ConsolePlugin',
  abbr: 'CP',
  label: 'ConsolePlugin',
  labelPlural: 'ConsolePlugins',
  plural: 'consoleplugins',
  namespaced: false,
};

export const ClusterVersionModel: K8sModel = {
  apiGroup: 'config.openshift.io',
  apiVersion: 'v1',
  kind: 'ClusterVersion',
  abbr: 'CV',
  label: 'ClusterVersion',
  labelPlural: 'ClusterVersions',
  plural: 'clusterversions',
  namespaced: false,
};

export const DeploymentModel: K8sModel = {
  apiGroup: 'apps',
  apiVersion: 'v1',
  kind: 'Deployment',
  abbr: 'D',
  label: 'Deployment',
  labelPlural: 'Deployments',
  plural: 'deployments',
  namespaced: true,
};

export const ServiceModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'Service',
  abbr: 'SVC',
  label: 'Service',
  labelPlural: 'Services',
  plural: 'services',
  namespaced: true,
};

export const ServiceAccountModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'ServiceAccount',
  abbr: 'SA',
  label: 'ServiceAccount',
  labelPlural: 'ServiceAccounts',
  plural: 'serviceaccounts',
  namespaced: true,
};

export const SecretModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'Secret',
  abbr: 'S',
  label: 'Secret',
  labelPlural: 'Secrets',
  plural: 'secrets',
  namespaced: true,
};

export const ClusterRoleModel: K8sModel = {
  apiGroup: 'rbac.authorization.k8s.io',
  apiVersion: 'v1',
  kind: 'ClusterRole',
  abbr: 'CR',
  label: 'ClusterRole',
  labelPlural: 'ClusterRoles',
  plural: 'clusterroles',
  namespaced: false,
};

export const ClusterRoleBindingModel: K8sModel = {
  apiGroup: 'rbac.authorization.k8s.io',
  apiVersion: 'v1',
  kind: 'ClusterRoleBinding',
  abbr: 'CRB',
  label: 'ClusterRoleBinding',
  labelPlural: 'ClusterRoleBindings',
  plural: 'clusterrolebindings',
  namespaced: false,
};

export const RoleModel: K8sModel = {
  apiGroup: 'rbac.authorization.k8s.io',
  apiVersion: 'v1',
  kind: 'Role',
  abbr: 'R',
  label: 'Role',
  labelPlural: 'Roles',
  plural: 'roles',
  namespaced: true,
};

export const RoleBindingModel: K8sModel = {
  apiGroup: 'rbac.authorization.k8s.io',
  apiVersion: 'v1',
  kind: 'RoleBinding',
  abbr: 'RB',
  label: 'RoleBinding',
  labelPlural: 'RoleBindings',
  plural: 'rolebindings',
  namespaced: true,
};

export const PersistentVolumeClaimModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  abbr: 'PVC',
  label: 'PersistentVolumeClaim',
  labelPlural: 'PersistentVolumeClaims',
  plural: 'persistentvolumeclaims',
  namespaced: true,
};

export const RouteModel: K8sModel = {
  apiGroup: 'route.openshift.io',
  apiVersion: 'v1',
  kind: 'Route',
  abbr: 'RT',
  label: 'Route',
  labelPlural: 'Routes',
  plural: 'routes',
  namespaced: true,
};

export const KIND_MODELS: Record<string, K8sModel> = {
  ConfigMap: ConfigMapModel,
  Namespace: NamespaceModel,
  Console: ConsoleOperatorModel,
  ConsolePlugin: ConsolePluginModel,
  Deployment: DeploymentModel,
  Service: ServiceModel,
  ServiceAccount: ServiceAccountModel,
  Secret: SecretModel,
  ClusterRole: ClusterRoleModel,
  ClusterRoleBinding: ClusterRoleBindingModel,
  Role: RoleModel,
  RoleBinding: RoleBindingModel,
  PersistentVolumeClaim: PersistentVolumeClaimModel,
  Route: RouteModel,
};

export function modelForKind(kind: string): K8sModel | undefined {
  return KIND_MODELS[kind];
}
