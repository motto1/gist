const fs = require('fs');
const filePath = 'F:/cherry-studio-main/src/main/services/NovelCompressionService.ts';

// 读取文件
let content = fs.readFileSync(filePath, 'utf8');

// 要插入的新函数
const newFunction = `
/**
 * 生成模型健康度统计数据
 * @param modelHealthMap 模型健康度映射
 * @param modelExecutors 模型执行器数组
 * @returns 格式化的健康度统计数组
 */
function generateModelHealthStats(
  modelHealthMap: Map<string, ModelHealth>,
  modelExecutors: ModelExecutor[]
): any[] {
  return Array.from(modelHealthMap.entries()).map(([healthKey, health]) => {
    const executorIndex = parseInt(healthKey, 10)
    const executor = modelExecutors[executorIndex]
    return {
      index: executorIndex,
      model: executor?.model.name || health.modelId,
      provider: executor?.providerId || 'unknown',
      baseUrl: executor?.providerOptions?.baseURL?.slice(0, 30) || 'N/A',
      successRate: \`\${Math.round(health.successRate * 100)}%\`,
      successes: health.successCount,
      failures: health.failureCount,
      total: health.totalAttempts,
      healthy: health.isHealthy,
      lastError: health.lastError
    }
  })
}
`;

// 查找插入位置：processConcurrently 函数之后，GenerateTextResponse 接口之前
const target = 'interface GenerateTextResponse {';
const insertPos = content.indexOf(target);

if (insertPos === -1) {
  console.error('❌ 目标位置未找到');
  process.exit(1);
}

// 插入新函数
const newContent = content.slice(0, insertPos) + newFunction + '\n\n' + content.slice(insertPos);

// 写回文件
fs.writeFileSync(filePath, newContent, 'utf8');

console.log('✅ 成功添加 generateModelHealthStats 函数');
