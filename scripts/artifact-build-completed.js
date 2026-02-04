const fs = require('fs')

exports.default = function (buildResult) {
  try {
    console.log('[artifact build completed] rename artifact file...')
    const buildSuffix = process.env.BUILD_SUFFIX
    const shouldAppendSuffix = typeof buildSuffix === 'string' && buildSuffix.trim().length > 0
    const normalizedSuffix = shouldAppendSuffix
      ? buildSuffix
          .trim()
          .replace(/\s+/g, '-')
          .replace(/[^0-9A-Za-z._-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-+|-+$/g, '')
      : ''
    if (!buildResult.file.includes(' ')) {
      if (!normalizedSuffix) {
        return
      }
    }

    let oldFilePath = buildResult.file
    let newfilePath = oldFilePath.replace(/ /g, '-')
    if (normalizedSuffix) {
      const lastDotIndex = newfilePath.lastIndexOf('.')
      if (lastDotIndex > 0) {
        newfilePath = `${newfilePath.slice(0, lastDotIndex)}-${normalizedSuffix}${newfilePath.slice(lastDotIndex)}`
      }
    }
    fs.renameSync(oldFilePath, newfilePath)
    buildResult.file = newfilePath
    console.log(`[artifact build completed] rename file ${oldFilePath} to ${newfilePath} `)
  } catch (error) {
    console.error('Error renaming file:', error)
  }
}
