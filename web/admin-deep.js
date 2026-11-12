// 深度交友配对批次页：共用 admin-batch.js 组件，仅提供配置。
window.AdminBatch({
 endpoint:'/api/admin/deep-batches',
 labels:{open:'等待截止',preview:'预览待确认',published:'已发布',missed:'本批未发布，已结束'},
 statRows:s=>[['参与人数',s.users],['有效问卷',s.eligible],['有候选的问卷',s.with_candidates],['配对数',s.pairs],['配上人数',s.matched_users],['未配上人数',s.unmatched],['平均内部得分',s.mean_score??'—']],
 excludedLine:s=>s.excluded&&s.excluded.count?`<p class="muted">因问卷校验未通过被排除 ${s.excluded.count} 人，重新保存问卷后会自动参与下一批。</p>`:'',
 batchNote:'<p class="muted">先尽量增加配对人数，再提高契合度。分数不是关系成功率。</p>',
 feedback:true,
 empty:'<p>暂无批次，系统启动后自动建立下一批。</p>',
 errorText:'处理未完成，请检查服务日志并重试，不会发布未验证的结果。',
 confirmApprove:'确认当前预览并授权到时发布？',
 confirmPublish:'确认向本批用户发布？'
});
