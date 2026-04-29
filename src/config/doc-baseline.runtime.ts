import {
  loadPluginManifestRegistryAsync as loadPluginManifestRegistryAsyncImpl,
  loadPluginManifestRegistrySync as loadPluginManifestRegistrySyncImpl,
} from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadata as collectChannelSchemaMetadataImpl,
  collectPluginSchemaMetadata as collectPluginSchemaMetadataImpl,
} from "./channel-config-metadata.js";
import { buildConfigSchema as buildConfigSchemaImpl } from "./schema.js";

export const loadPluginManifestRegistrySync = loadPluginManifestRegistrySyncImpl;
export const loadPluginManifestRegistryAsync = loadPluginManifestRegistryAsyncImpl;
export const collectChannelSchemaMetadata = collectChannelSchemaMetadataImpl;
export const collectPluginSchemaMetadata = collectPluginSchemaMetadataImpl;
export const buildConfigSchema = buildConfigSchemaImpl;
