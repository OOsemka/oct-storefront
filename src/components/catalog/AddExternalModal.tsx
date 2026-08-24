import React, { FC, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  FileUpload,
  Form,
  FormGroup,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  TextArea,
  HelperText,
  HelperTextItem,
} from '@patternfly/react-core';
import { CommunityTool } from '../../utils/catalog-types';
import { parseSingleTool } from '../../utils/parse-tools';

export const AddExternalModal: FC<{
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (tool: CommunityTool) => Promise<void>;
}> = ({ isOpen, onClose, onSubmit }) => {
  const { t } = useTranslation('plugin__oct-storefront');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = (_e: unknown, file: File) => {
    setFilename(file.name);
    file.text().then(setText).catch((e) => setError(String(e)));
  };

  const submit = async () => {
    setError(null);
    const parsed = parseSingleTool(text);
    if (parsed.error || !parsed.tool) {
      setError(parsed.error || t('Could not parse CommunityTool YAML.'));
      return;
    }
    setBusy(true);
    try {
      await onSubmit(parsed.tool);
      setText('');
      setFilename('');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} variant="medium" aria-labelledby="ct-add-external-title">
      <ModalHeader title={t('Add external extension')} labelId="ct-add-external-title" />
      <ModalBody>
        <Form>
          <FormGroup label={t('CommunityTool YAML')} fieldId="ct-external-yaml">
            <FileUpload
              id="ct-external-file"
              value={filename}
              filename={filename}
              filenamePlaceholder={t('Upload a .yaml file')}
              onFileInputChange={handleFile}
              browseButtonText={t('Upload')}
            />
            <TextArea
              id="ct-external-yaml"
              className="ct-yaml"
              rows={16}
              value={text}
              onChange={(_e, v) => setText(v)}
              placeholder={t(
                'Paste a CommunityTool document. spec.versions (or spec.validatedOn) is required, for example versions: [{ version: "1.0.0", channel: "stable", openshift: ["4.22"], image: "quay.io/example/oct-tool:1.0.0" }].',
              )}
            />
            <HelperText>
              <HelperTextItem>
                {t(
                  'Required: metadata.name, spec.displayName, spec.category, spec.consolePlugin, spec.versions or spec.validatedOn. Provide spec.versions[].image, spec.deployYAML, spec.deployURL, or spec.image. Optional spec.pinVersion keeps Add on that semver.',
                )}
              </HelperTextItem>
            </HelperText>
          </FormGroup>
          {error ? (
            <HelperText>
              <HelperTextItem variant="error">{error}</HelperTextItem>
            </HelperText>
          ) : null}
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={submit} isDisabled={busy || !text.trim()} isLoading={busy}>
          {t('Add')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t('Cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

export default AddExternalModal;
