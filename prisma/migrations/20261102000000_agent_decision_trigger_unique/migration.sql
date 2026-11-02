-- P0.5: no máximo uma decisão do agente por mensagem do funcionário (idempotência da resposta).

-- CreateIndex
CREATE UNIQUE INDEX "agent_decisions_triggerMessageId_key" ON "agent_decisions"("triggerMessageId");
