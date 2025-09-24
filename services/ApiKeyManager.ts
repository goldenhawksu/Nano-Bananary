import { GoogleGenAI } from "@google/genai";

class ApiKeyManager {
    private keys: string[] = [];
    private instances: GoogleGenAI[] = [];
    private currentIndex = 0;
    private blockedKeys = new Set<number>();

    constructor() {
        const keyString = process.env.GEMINI_API_KEY || process.env.API_KEY || '';
        this.keys = keyString.split(',').map(k => k.trim()).filter(k => k);

        if (this.keys.length === 0) {
            throw new Error("API_KEY environment variable is not set.");
        }

        this.instances = this.keys.map(key => new GoogleGenAI({ apiKey: key }));
    }

    async executeWithRetry<T>(operation: (ai: GoogleGenAI) => Promise<T>): Promise<T> {
        const result = await this.executeWithRetryAndKey(operation);
        return result.result;
    }

    async executeWithRetryAndKey<T>(operation: (ai: GoogleGenAI) => Promise<T>): Promise<{ result: T; apiKey: string }> {
        // 单key模式直接执行
        if (this.instances.length === 1) {
            const result = await operation(this.instances[0]);
            return { result, apiKey: this.keys[0] };
        }

        // 多key模式尝试轮询
        for (let attempt = 0; attempt < Math.min(3, this.instances.length); attempt++) {
            try {
                const ai = this.getCurrentApiInstance();
                const currentKeyIndex = this.currentIndex;
                const result = await operation(ai);
                return { result, apiKey: this.keys[currentKeyIndex] };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : '';

                // 仅在配额/频率限制错误时轮询下一个key
                if (this.shouldRotateKey(errorMessage)) {
                    this.blockedKeys.add(this.currentIndex);
                    this.currentIndex = (this.currentIndex + 1) % this.instances.length;
                    continue;
                }

                throw error;
            }
        }

        throw new Error("All API keys are temporarily unavailable");
    }

    private getCurrentApiInstance(): GoogleGenAI {
        let attempts = 0;
        while (attempts < this.instances.length) {
            if (!this.blockedKeys.has(this.currentIndex)) {
                return this.instances[this.currentIndex];
            }
            this.currentIndex = (this.currentIndex + 1) % this.instances.length;
            attempts++;
        }

        // 如果所有key都被阻止，清除阻止状态重新开始
        this.blockedKeys.clear();
        return this.instances[this.currentIndex];
    }

    private shouldRotateKey(errorMessage: string): boolean {
        return errorMessage.includes('RESOURCE_EXHAUSTED') ||
               errorMessage.includes('quota exceeded') ||
               errorMessage.includes('rate limit');
    }
}

export const apiKeyManager = new ApiKeyManager();
