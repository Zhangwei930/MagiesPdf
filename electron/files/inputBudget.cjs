class InputBudget {
  constructor({ maxFileBytes, maxTotalBytes, maxFiles }) {
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.maxFiles = maxFiles;
    this.totalBytes = 0;
    this.fileCount = 0;
  }

  add(size) {
    if (size > this.maxFileBytes) throw new Error('File is too large to open');
    if (this.fileCount + 1 > this.maxFiles) throw new Error('Too many files were selected');
    if (this.totalBytes + size > this.maxTotalBytes) {
      throw new Error('Total input size is too large to open safely');
    }
    this.fileCount += 1;
    this.totalBytes += size;
  }
}

module.exports = { InputBudget };
