import React, { FC, useState } from 'react';
import { DocumentTitle } from '@openshift-console/dynamic-plugin-sdk';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  EmptyState,
  EmptyStateBody,
  FormSelect,
  FormSelectOption,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PageSection,
  SearchInput,
  Stack,
  StackItem,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { PlusCircleIcon } from '@patternfly/react-icons';
import CommunityDisclaimer from '../CommunityDisclaimer';
import {
  CatalogItem,
  CatalogSort,
  ToolCategory,
  findToolVersion,
  pickToolVersion,
} from '../../utils/catalog-types';
import { useCatalog } from './useCatalog';
import ExtensionTile from './ExtensionTile';
import { AddExternalModal } from './AddExternalModal';
import './catalog.css';

const I18N = 'plugin__oct-storefront';

const HUB_COPY: Record<ToolCategory, { title: string; description: string }> = {
  compute: {
    title: 'Compute',
    description: 'Compute extensions for machines and hosts. Add Bare Metal Hosts from the catalog.',
  },
  storage: {
    title: 'Storage',
    description: 'Storage extensions for OpenShift Data Foundation and related networking.',
  },
  network: {
    title: 'Network',
    description: 'Network extensions for NMState, bonding, and related node networking.',
  },
  management: {
    title: 'Management',
    description: 'Cluster management extensions that do not fit Compute, Storage, or Network.',
  },
};

export const CategoryHubPage: FC<{ category: ToolCategory }> = ({ category }) => {
  const { t } = useTranslation(I18N);
  const copy = HUB_COPY[category];
  const catalog = useCatalog(category);
  const [externalOpen, setExternalOpen] = useState(false);
  const [versionPick, setVersionPick] = useState<{
    item: CatalogItem;
    clusterMinor: string;
    available: string[];
    unsupported: boolean;
    selected: string;
  } | null>(null);
  const title = t(copy.title);

  const requestAdd = (item: CatalogItem) => {
    const picked = pickToolVersion(item.tool.spec, catalog.clusterVersion);
    if (
      picked.status === 'choose' ||
      picked.status === 'unsupported' ||
      picked.status === 'pinned-incompatible'
    ) {
      setVersionPick({
        item,
        clusterMinor: picked.clusterMinor,
        available: picked.available,
        unsupported: picked.status !== 'choose',
        selected: picked.available[0] || '',
      });
      return;
    }
    catalog.add(item, picked.version);
  };

  const confirmVersion = () => {
    if (!versionPick) return;
    const version = findToolVersion(versionPick.item.tool.spec, versionPick.selected);
    catalog.add(versionPick.item, version);
    setVersionPick(null);
  };

  return (
    <>
      <DocumentTitle>{`${t('Community Tools')} · ${title}`}</DocumentTitle>
      <PageSection>
        <Stack hasGutter>
          <StackItem>
            <Title headingLevel="h1">{title}</Title>
            <p className="ct-lead">{t(copy.description)}</p>
          </StackItem>
          <StackItem>
            <CommunityDisclaimer />
          </StackItem>
          {!catalog.sync.ok ? (
            <StackItem>
              <Alert isInline variant="info" title={t('Catalog stats are local — public catalog unreachable.')}>
                {catalog.sync.message ||
                  t('Browsing and Add/Remove still work from the on-cluster cache and bundled catalog.')}
              </Alert>
            </StackItem>
          ) : null}
          {catalog.error ? (
            <StackItem>
              <Alert isInline variant="danger" title={t('Action failed')}>
                {catalog.error}
              </Alert>
            </StackItem>
          ) : null}
          {catalog.notice ? (
            <StackItem>
              <Alert isInline variant="success" title={t('Success')}>
                {catalog.notice}
              </Alert>
            </StackItem>
          ) : null}
          <StackItem>
            <Toolbar>
              <ToolbarContent>
                <ToolbarItem>
                  <SearchInput
                    aria-label={t('Search extensions')}
                    value={catalog.query}
                    onChange={(_e, v) => catalog.setQuery(v)}
                    onClear={() => catalog.setQuery('')}
                    placeholder={t('Search by name')}
                  />
                </ToolbarItem>
                <ToolbarItem>
                  <FormSelect
                    id={`ct-sort-${category}`}
                    value={catalog.sort}
                    onChange={(_e, v) => catalog.setSort(v as CatalogSort)}
                    aria-label={t('Sort')}
                  >
                    <FormSelectOption value="name" label={t('Name')} />
                    <FormSelectOption value="downloads" label={t('Downloads')} />
                    <FormSelectOption value="rating" label={t('Rating')} />
                  </FormSelect>
                </ToolbarItem>
                <ToolbarItem>
                  <FormSelect
                    id={`ct-ocp-${category}`}
                    value={catalog.versionFilter}
                    onChange={(_e, v) => catalog.setVersionFilter(v)}
                    aria-label={t('Filter by OpenShift version')}
                  >
                    <FormSelectOption value="" label={t('All OpenShift versions')} />
                    {catalog.clusterVersion ? (
                      <FormSelectOption
                        value={catalog.clusterVersion}
                        label={t('This cluster ({{version}})', { version: catalog.clusterVersion })}
                      />
                    ) : null}
                    <FormSelectOption value="4.22" label="4.22" />
                    <FormSelectOption value="4.21" label="4.21" />
                    <FormSelectOption value="4.20" label="4.20" />
                  </FormSelect>
                </ToolbarItem>
                <ToolbarItem>
                  <Button variant="secondary" onClick={() => setExternalOpen(true)}>
                    {t('Add external extension')}
                  </Button>
                </ToolbarItem>
              </ToolbarContent>
            </Toolbar>
          </StackItem>
          <StackItem>
            {catalog.items.length === 0 ? (
              <EmptyState titleText={t('No extensions in this category')} headingLevel="h2" icon={PlusCircleIcon}>
                <EmptyStateBody>
                  {t(
                    'Community extensions are listed in catalog/community.yaml. Add an external CommunityTool YAML, or contribute a catalog PR. See AGENTS.md.',
                  )}
                </EmptyStateBody>
              </EmptyState>
            ) : (
              <div className="ct-grid">
                {catalog.items.map((item) => (
                  <ExtensionTile
                    key={item.id}
                    item={item}
                    preferPublic={catalog.preferPublic}
                    busy={catalog.busyId === item.id}
                    onAdd={() => requestAdd(item)}
                    onEnable={() => catalog.enable(item)}
                    onUpdate={() => catalog.update(item)}
                    onRemove={() => catalog.remove(item)}
                    onRate={(stars) => catalog.rate(item, stars)}
                  />
                ))}
              </div>
            )}
          </StackItem>
        </Stack>
      </PageSection>
      <AddExternalModal
        isOpen={externalOpen}
        onClose={() => setExternalOpen(false)}
        onSubmit={catalog.addExternal}
      />
      <Modal
        isOpen={Boolean(versionPick)}
        onClose={() => setVersionPick(null)}
        variant="small"
        aria-labelledby="ct-version-pick-title"
      >
        <ModalHeader title={t('Select version')} labelId="ct-version-pick-title" />
        <ModalBody>
          {versionPick?.unsupported ? (
            <Alert isInline variant="warning" title={t('No matching plugin image')}>
              {t(
                'This cluster is OpenShift {{version}}. No catalog entry matches that minor. Installing another version may break the console. Available: {{available}}.',
                {
                  version: versionPick.clusterMinor,
                  available: versionPick.available.join(', ') || t('none'),
                },
              )}
            </Alert>
          ) : (
            <p>
              {t(
                'Cluster OpenShift version could not be detected. Choose which extension version to install.',
              )}
            </p>
          )}
          <FormSelect
            id="ct-version-pick"
            value={versionPick?.selected || ''}
            onChange={(_e, v) => setVersionPick((cur) => (cur ? { ...cur, selected: v } : cur))}
            aria-label={t('Select version')}
          >
            {(versionPick?.available || []).map((v) => (
              <FormSelectOption key={v} value={v} label={v} />
            ))}
          </FormSelect>
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={confirmVersion} isDisabled={!versionPick?.selected}>
            {t('Install')}
          </Button>
          <Button variant="link" onClick={() => setVersionPick(null)}>
            {t('Cancel')}
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
};

export default CategoryHubPage;
