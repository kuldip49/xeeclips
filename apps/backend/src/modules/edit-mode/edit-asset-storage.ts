import type { EditAssetStorageOwnership } from '@prisma/client';

export type EditAssetStorageRecord = {
  bucket: string;
  objectKey: string;
  storageObjectKey?: string | null;
  storageOwnership?: EditAssetStorageOwnership | 'OWNED' | 'SHARED' | null;
};

/** The only place that translates an editor asset identity into object storage. */
export const editAssetStorageLocation = (asset: EditAssetStorageRecord) => ({
  bucket: asset.bucket,
  objectKey: asset.storageObjectKey || asset.objectKey
});

/** Shared Video objects are never lifecycle-owned by an EditProject. */
export const editAssetOwnsStorage = (asset: EditAssetStorageRecord) =>
  (asset.storageOwnership ?? 'OWNED') === 'OWNED';
