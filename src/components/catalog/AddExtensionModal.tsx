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
} from '@patternfly/react-core';
import { PvcSummary } from '../../utils/apply-yaml';

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

  return (
    <Modal
      isOpen={Boolean(state)}
      onClose={onClose}
      variant="small"
      aria-labelledby="ct-add-extension-title"
    >
      <ModalHeader title={t('Add {{name}}', { name: state?.displayName || '' })} labelId="ct-add-extension-title" />
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
          {state?.needsStorageClass ? (
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
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          onClick={onConfirm}
          isDisabled={Boolean(state?.needsVersion && !state.selectedVersion)}
        >
          {t('Install')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default AddExtensionModal;
