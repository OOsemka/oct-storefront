import React, { FC } from 'react';
import { K8sResourceCommon, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
  Switch,
} from '@patternfly/react-core';
import { PvcSummary } from '../../utils/apply-yaml';
import {
  isNotFoundError,
  isWatchAllNamespacesEnabled,
  PROVISIONING_GVK,
  PROVISIONING_NAME,
  ProvisioningKind,
  WATCH_ALL_NAMESPACES_OC_PATCH,
} from '../../utils/metal3-provisioning';

const I18N = 'plugin__oct-storefront';
const DEFAULT_SC_ANN = 'storageclass.kubernetes.io/is-default-class';

type StorageClassKind = K8sResourceCommon & {
  provisioner?: string;
};

function isDefaultStorageClass(sc: StorageClassKind): boolean {
  return sc.metadata?.annotations?.[DEFAULT_SC_ANN] === 'true';
}

export type AddExtensionModalState = {
  displayName: string;
  clusterMinor: string;
  available: string[];
  unsupported: boolean;
  selectedVersion: string;
  needsVersion: boolean;
  needsStorageClass: boolean;
  storageClass: string;
  pvcSummaries: PvcSummary[];
  mode?: 'add' | 'change';
  versionChoices?: string[];
  installedVersion?: string;
  needsWatchAllNamespaces?: boolean;
  enableWatchAllNamespaces?: boolean;
};

const WatchAllNamespacesField: FC<{
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
}> = ({ enabled, onEnabledChange }) => {
  const { t } = useTranslation(I18N);
  const [provisioning, loaded, error] = useK8sWatchResource<ProvisioningKind>({
    groupVersionKind: {
      group: PROVISIONING_GVK.group,
      version: PROVISIONING_GVK.version,
      kind: PROVISIONING_GVK.kind,
    },
    name: PROVISIONING_NAME,
  });

  if (!loaded) {
    return (
      <FormGroup label={t('BareMetal Operator namespace watch')} fieldId="ct-add-watch-all">
        <Spinner size="md" aria-label={t('Checking whether BareMetal Operator watches all namespaces')} />
      </FormGroup>
    );
  }

  if (error && !isNotFoundError(error)) {
    return (
      <FormGroup label={t('BareMetal Operator namespace watch')} fieldId="ct-add-watch-all">
        <div className="ct-add-watch">
          <Alert isInline variant="warning" title={t('Could not read Provisioning configuration')}>
            {t(
              'Add uses your console credentials to patch spec.watchAllNamespaces. If that fails, you will see this command:',
            )}
            <code className="ct-add-oc-cmd">{WATCH_ALL_NAMESPACES_OC_PATCH}</code>
          </Alert>
          <Switch
            id="ct-add-watch-all"
            isChecked={enabled}
            onChange={(_e, checked) => onEnabledChange(checked)}
            label={t('Watch BareMetalHosts in all namespaces (recommended)')}
          />
          {!enabled ? (
            <Alert isInline variant="warning" title={t('Hosts in other namespaces will stay Unknown')}>
              {t(
                'BareMetal Operator only reconciles BareMetalHosts in openshift-machine-api. The plugin will still install.',
              )}
            </Alert>
          ) : null}
        </div>
      </FormGroup>
    );
  }

  if (isWatchAllNamespacesEnabled(provisioning)) {
    return (
      <Alert isInline variant="success" title={t('BareMetal Operator already watches all namespaces')} />
    );
  }

  return (
    <FormGroup label={t('BareMetal Operator namespace watch')} fieldId="ct-add-watch-all">
      <div className="ct-add-watch">
        <Alert isInline variant="warning" title={t('BareMetal Operator is not watching all namespaces')}>
          {t(
            'BareMetal Operator only reconciles BareMetalHosts in openshift-machine-api. Hosts in other namespaces stay Unknown until spec.watchAllNamespaces is true.',
          )}
        </Alert>
        <Switch
          id="ct-add-watch-all"
          isChecked={enabled}
          onChange={(_e, checked) => onEnabledChange(checked)}
          label={t('Watch BareMetalHosts in all namespaces (recommended)')}
        />
        {!enabled ? (
          <Alert isInline variant="warning" title={t('Hosts in other namespaces will stay Unknown')}>
            {t(
              'The plugin will still install. Set spec.watchAllNamespaces: true later, or keep hosts in openshift-machine-api. Command:',
            )}
            <code className="ct-add-oc-cmd">{WATCH_ALL_NAMESPACES_OC_PATCH}</code>
          </Alert>
        ) : (
          <HelperText>
            <HelperTextItem>
              {t(
                'Install will patch Provisioning/provisioning-configuration with your console credentials. This does not use a plugin ServiceAccount.',
              )}
            </HelperTextItem>
          </HelperText>
        )}
      </div>
    </FormGroup>
  );
};

export const AddExtensionModal: FC<{
  state: AddExtensionModalState | null;
  onChange: (next: AddExtensionModalState) => void;
  onClose: () => void;
  onConfirm: () => void;
}> = ({ state, onChange, onClose, onConfirm }) => {
  const { t } = useTranslation(I18N);
  const [storageClasses] = useK8sWatchResource<StorageClassKind[]>({
    groupVersionKind: { group: 'storage.k8s.io', version: 'v1', kind: 'StorageClass' },
    isList: true,
  });

  const scList = Array.isArray(storageClasses) ? storageClasses : [];
  const defaultSc = scList.find(isDefaultStorageClass);
  const pvcLine = (state?.pvcSummaries || [])
    .map((p) => (p.size ? `${p.name} (${p.size})` : p.name))
    .join(', ');
  const isChange = state?.mode === 'change';
  const versionChoices = state?.versionChoices || [];
  const showSemverPick = Boolean(state) && !state?.needsVersion && (isChange || versionChoices.length > 1);
  const showWatch = Boolean(state?.needsWatchAllNamespaces) && !isChange;

  return (
    <Modal
      isOpen={Boolean(state)}
      onClose={onClose}
      variant={showWatch ? 'medium' : 'small'}
      aria-labelledby="ct-add-extension-title"
    >
      <ModalHeader
        title={
          isChange
            ? t('Change version of {{name}}', { name: state?.displayName || '' })
            : t('Add {{name}}', { name: state?.displayName || '' })
        }
        labelId="ct-add-extension-title"
      />
      <ModalBody>
        <Form>
          {state?.unsupported ? (
            <Alert isInline variant="warning" title={t('No matching plugin image')}>
              {t(
                'This cluster is OpenShift {{version}}. No catalog entry matches that minor. Installing another version may break the console. Available: {{available}}.',
                {
                  version: state.clusterMinor,
                  available: state.available.join(', ') || t('none'),
                },
              )}
            </Alert>
          ) : null}
          {state?.needsVersion ? (
            <FormGroup label={t('Select version')} fieldId="ct-add-version">
              {!state.unsupported ? (
                <p>
                  {t(
                    'Cluster OpenShift version could not be detected. Choose which extension version to install.',
                  )}
                </p>
              ) : null}
              <FormSelect
                id="ct-add-version"
                value={state.selectedVersion}
                onChange={(_e, v) => onChange({ ...state, selectedVersion: v })}
                aria-label={t('Select version')}
              >
                {state.available.map((v) => (
                  <FormSelectOption key={v} value={v} label={v} />
                ))}
              </FormSelect>
            </FormGroup>
          ) : null}
          {showSemverPick && state ? (
            <FormGroup label={t('Select version')} fieldId="ct-add-semver">
              <FormSelect
                id="ct-add-semver"
                value={state.selectedVersion}
                onChange={(_e, v) => onChange({ ...state, selectedVersion: v })}
                aria-label={t('Select version')}
              >
                {versionChoices.map((v) => (
                  <FormSelectOption key={v} value={v} label={v} />
                ))}
              </FormSelect>
              {state.installedVersion ? (
                <HelperText>
                  <HelperTextItem>{t('Installed {{version}}', { version: state.installedVersion })}</HelperTextItem>
                </HelperText>
              ) : null}
            </FormGroup>
          ) : null}
          {state?.needsStorageClass ? (
            // Cluster-portable: admin picks the class at Add. Never default a lab StorageClass name.
            <FormGroup label={t('Storage class')} fieldId="ct-add-storage-class">
              <FormSelect
                id="ct-add-storage-class"
                value={state.storageClass}
                onChange={(_e, v) => onChange({ ...state, storageClass: v })}
                aria-label={t('Storage class')}
              >
                <FormSelectOption
                  value=""
                  label={
                    defaultSc?.metadata?.name
                      ? t('Cluster default ({{name}})', { name: defaultSc.metadata.name })
                      : t('Cluster default')
                  }
                />
                {scList.map((sc) => {
                  const name = sc.metadata?.name || '';
                  const suffix = isDefaultStorageClass(sc) ? ` (${t('default')})` : '';
                  return <FormSelectOption key={name} value={name} label={`${name}${suffix}`} />;
                })}
              </FormSelect>
              <HelperText>
                <HelperTextItem>
                  {pvcLine
                    ? t(
                        'This extension precreates PersistentVolumeClaim {{pvcs}} before the plugin starts. Leave as cluster default unless you need a specific class. storageClassName is set at create time and cannot change after the PVC is Bound.',
                        { pvcs: pvcLine },
                      )
                    : t(
                        'This extension precreates PersistentVolumeClaims before the plugin starts. Leave as cluster default unless you need a specific class.',
                      )}
                </HelperTextItem>
              </HelperText>
            </FormGroup>
          ) : null}
          {showWatch && state ? (
            <WatchAllNamespacesField
              enabled={state.enableWatchAllNamespaces !== false}
              onEnabledChange={(value) => onChange({ ...state, enableWatchAllNamespaces: value })}
            />
          ) : null}
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          onClick={onConfirm}
          isDisabled={Boolean(state?.needsVersion && !state.selectedVersion) || Boolean(showSemverPick && !state?.selectedVersion)}
        >
          {isChange ? t('Apply') : t('Install')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default AddExtensionModal;
