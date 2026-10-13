/**
 * Entry point of the package.
 *
 * ## n8n does not load the node through this file
 *
 * n8n reads the `n8n` block of `package.json`, which points straight at the
 * COMPILED files — `dist/src/nodes/FactuareaTrigger/FactuareaTrigger.node.js`
 * and `dist/src/credentials/FactuareaApi.credentials.js` — and instantiates the
 * class each one exports. That is the loading contract for a community package,
 * and it does not involve `main` at all.
 *
 * This file is the entry point for everything ELSE: `package.json` declares it
 * as `main` and `types`, so it is what a `require('n8n-nodes-factuarea')` or an
 * editor resolves. Keeping it in step with the manifest is what stops the two
 * from describing different packages.
 *
 * ## Named re-exports, not a star
 *
 * The registered classes are re-exported by name. A star re-export would silently widen
 * the package's public surface with whatever a module happens to export next,
 * and the surface here contains the genuine trigger, CRM and WhatsApp actions,
 * plus the API-key and separate CRM OAuth credential types. That is also what the manifest declares and what the
 * package gate checks, so anything else appearing here would make the two
 * disagree.
 */

export { FactuareaTrigger } from './nodes/FactuareaTrigger/FactuareaTrigger.node';
export { FactuareaApi } from './credentials/FactuareaApi.credentials';
export { FactuareaCrm } from './nodes/FactuareaCrm/FactuareaCrm.node';

export { FactuareaCrmOAuth2Api } from './credentials/FactuareaCrmOAuth2Api.credentials';
export { FactuareaWhatsApp } from './nodes/FactuareaWhatsApp/FactuareaWhatsApp.node';

export {FactuareaMeta} from './nodes/crmMetaNativeBatch80/FactuareaMeta.node';
