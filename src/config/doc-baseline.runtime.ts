import { loadPluginManifestRegistrySync as loadPluginManifestRegistrySyncImpl } from "../plugins/manifest-registry.js";
import {
  collectChannelSchemaMetadata as collectChannelSchemaMetadataImpl,
  collectPluginSchemaMetadata as collectPluginSchemaMetadataImpl,
} from "./channel-config-metadata.js";
import { buildConfigSchema as buildConfigSchemaImpl } from "./schema.js";

export const loadPluginManifestRegistrySync = loadPluginManifestRegistrySyncImpl;
export const collectChannelSchemaMetadata = collectChannelSchemaMetadataImpl;
export const collectPluginSchemaMetadata = collectPluginSchemaMetadataImpl;
export const buildConfigSchema = buildConfigSchemaImpl;
