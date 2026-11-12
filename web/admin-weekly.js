// 每周恋爱配对批次页：共用 admin-batch.js 组件，仅提供配置。
window.AdminBatch({
 endpoint:'/api/admin/weekly-batches',
 labels:{open:'报名中 / 等待预览',preview:'预览待确认',published:'已发布',missed:'未按期发布，已结束'},
 statRows:s=>[['报名',s.enrolled],['符合资格',s.eligible],['有候选',s.with_candidates],['配对数',s.pairs],['优先档',s.preferred],['补充档',s.supplement],['未配上',s.unmatched],['平均内部得分',s.mean_score??'—']],
 excludedLine:s=>s.excluded&&s.excluded.count?`<p class="muted">因问卷版本过期或不合法被排除 ${s.excluded.count} 人（版本过期 ${s.excluded.reasons.version_expired||0}，校验未通过 ${s.excluded.reasons.invalid||0}）。这些人需重新保存问卷后重新报名。</p>`:'',
 batchNote:'<p class="muted">得分仅用于内部排序，不是关系成功率。无候选、人数奇数等仍可能导致轮空。</p>',
 showPublished:true,feedback:true,
 empty:'<section class="card">暂无批次。用户进入每周配对页面后会建立可报名批次。</section>',
 errorText:'处理未完成，请检查服务日志并重试；不会降级为随意配对。',
 confirmApprove:'确认当前预览，授权系统到时发布？',
 confirmPublish:'到发布时间后将正式发布给报名用户，确认继续？'
});
