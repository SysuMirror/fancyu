'use strict';
// Kept as an explicit guard for old integrations: weekly batches own publication.
module.exports=async()=>{throw Object.assign(Error('已改为每周统一配对'),{status:410});};
