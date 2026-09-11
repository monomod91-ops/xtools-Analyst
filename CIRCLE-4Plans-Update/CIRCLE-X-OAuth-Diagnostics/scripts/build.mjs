import {build} from 'esbuild';
import './legal-pages.mjs';
await build({entryPoints:['client/membership.mjs'],outfile:'public/assets/membership.js',bundle:true,
  format:'esm',platform:'browser',target:['es2022'],minify:true,sourcemap:false,legalComments:'eof'});
console.log('Membership client and seller information built.');
