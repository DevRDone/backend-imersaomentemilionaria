import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';

const app = express();
const PORT = process.env.PORT || 8080;
const prisma = new PrismaClient();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust proxy para obter IP real
app.set('trust proxy', true);

// Validações
function isValidEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  
  const cleanPhone = phone.replace(/\D/g, '');
  
  // Telefone brasileiro com código do país (55)
  if (cleanPhone.startsWith('55')) {
    const phoneWithoutCountry = cleanPhone.substring(2);
    return phoneWithoutCountry.length >= 10 && phoneWithoutCountry.length <= 11;
  }
  
  // Telefone brasileiro sem código do país
  return cleanPhone.length >= 10 && cleanPhone.length <= 11;
}


function sanitizeInput(str) {
  if (typeof str !== 'string') return str;
  return str.trim().replace(/[<>]/g, '');
}

// Middleware para log
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - IP: ${req.ip}`);
  next();
});

// Health check
app.get('/health', async (req, res) => {
  try {
    // Testa conexão com banco
    await prisma.$queryRaw`SELECT 1`;
    
    res.json({
      success: true,
      message: 'API funcionando e banco conectado!',
      timestamp: new Date().toISOString(),
      database: 'connected'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro na conexão com banco',
      database: 'disconnected'
    });
  }
});

// Capturar lead
app.post('/api/leads', async (req, res) => {
  try {
    let { 
      nome, 
      email, 
      telefone, 
      origem, 
      utm_source, 
      utm_medium, 
      utm_campaign,
      utm_content,
      utm_term 
    } = req.body;

    // Sanitizar inputs
    nome = sanitizeInput(nome);
    email = sanitizeInput(email);
    telefone = sanitizeInput(telefone);
    origem = sanitizeInput(origem);

    // Validações
    if (!nome || !email || !telefone) {
      return res.status(400).json({
        success: false,
        message: 'Nome, email e telefone são obrigatórios',
        code: 'MISSING_FIELDS'
      });
    }

    if (nome.length < 2) {
      return res.status(400).json({
        success: false,
        message: 'Nome deve ter pelo menos 2 caracteres',
        code: 'INVALID_NAME'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Email inválido',
        code: 'INVALID_EMAIL'
      });
    }

    if (!isValidPhone(telefone)) {
      return res.status(400).json({
        success: false,
        message: 'Telefone inválido',
        code: 'INVALID_PHONE'
      });
    }

    // Verificar se email já existe
    const existingLead = await prisma.lead.findUnique({
      where: { email: email.toLowerCase() }
    });

    if (existingLead) {
      return res.status(409).json({
        success: false,
        message: 'Este email já está cadastrado',
        code: 'EMAIL_EXISTS',
        data: {
          dataAnterior: existingLead.dataCaptura
        }
      });
    }

    // Capturar dados do request
    const userAgent = req.get('User-Agent') || null;
    const referer = req.get('Referer') || null;

    // Criar novo lead
    const newLead = await prisma.lead.create({
      data: {
        nome: nome.trim(),
        email: email.toLowerCase().trim(),
        telefone: telefone.trim(),
        origem: origem || 'website',
        utmSource: utm_source || null,
        utmMedium: utm_medium || null,
        utmCampaign: utm_campaign || null,
        utmContent: utm_content || null,
        utmTerm: utm_term || null,
        ip: req.ip,
        userAgent: userAgent,
        referer: referer,
        status: 'novo'
      }
    });

    console.log(`✅ Novo lead criado: ${newLead.email} - ${newLead.nome}`);

    // Resposta sem dados sensíveis
    res.status(201).json({
      success: true,
      message: 'Lead capturado com sucesso! Entraremos em contato em breve.',
      data: {
        id: newLead.id,
        nome: newLead.nome,
        email: newLead.email,
        dataCaptura: newLead.dataCaptura
      }
    });

  } catch (error) {
    console.error('❌ Erro ao capturar lead:', error);
    
    // Tratamento de erros específicos do Prisma
    if (error.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'Email já cadastrado',
        code: 'EMAIL_EXISTS'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Listar leads com filtros e paginação
app.get('/api/leads', async (req, res) => {
  try {
    const { key, page = 1, limit = 20, status, search, origem } = req.query;
    
    // Verificar autenticação
    if (key !== process.env.API_KEY && key !== 'mente-milionaria-2024') {
      return res.status(401).json({
        success: false,
        message: 'Acesso não autorizado',
        code: 'UNAUTHORIZED'
      });
    }

    // Construir filtros
    const where = {};
    
    if (status) {
      where.status = status;
    }
    
    if (origem) {
      where.origem = origem;
    }
    
    if (search) {
      where.OR = [
        { nome: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } }
      ];
    }

    // Paginação
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Buscar leads
    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        skip,
        take,
        orderBy: { dataCaptura: 'desc' },
        select: {
          id: true,
          nome: true,
          email: true,
          telefone: true,
          origem: true,
          status: true,
          utmSource: true,
          utmMedium: true,
          utmCampaign: true,
          dataCaptura: true,
          dataAtualizacao: true,
          ip: true
        }
      }),
      prisma.lead.count({ where })
    ]);

    res.json({
      success: true,
      data: leads,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit))
      },
      filters: { status, search, origem }
    });

  } catch (error) {
    console.error('❌ Erro ao buscar leads:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Buscar lead específico
app.get('/api/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { key } = req.query;
    
    if (key !== process.env.API_KEY && key !== 'mente-milionaria-2024') {
      return res.status(401).json({
        success: false,
        message: 'Acesso não autorizado',
        code: 'UNAUTHORIZED'
      });
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        // conversoes: true,
        // interacoes: true
      }
    });

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: 'Lead não encontrado',
        code: 'LEAD_NOT_FOUND'
      });
    }

    res.json({
      success: true,
      data: lead
    });

  } catch (error) {
    console.error('❌ Erro ao buscar lead:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Atualizar status do lead
app.patch('/api/leads/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { key } = req.query;
    const { status } = req.body;
    
    if (key !== process.env.API_KEY && key !== 'mente-milionaria-2024') {
      return res.status(401).json({
        success: false,
        message: 'Acesso não autorizado',
        code: 'UNAUTHORIZED'
      });
    }

    const validStatuses = ['novo', 'contatado', 'interessado', 'convertido', 'descartado'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Status inválido. Use: ' + validStatuses.join(', '),
        code: 'INVALID_STATUS'
      });
    }

    const updatedLead = await prisma.lead.update({
      where: { id },
      data: { status }
    });

    res.json({
      success: true,
      message: 'Status atualizado com sucesso',
      data: updatedLead
    });

  } catch (error) {
    if (error.code === 'P2025') {
      return res.status(404).json({
        success: false,
        message: 'Lead não encontrado',
        code: 'LEAD_NOT_FOUND'
      });
    }

    console.error('❌ Erro ao atualizar lead:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Estatísticas
app.get('/api/stats', async (req, res) => {
  try {
    const { key } = req.query;
    
    if (key !== process.env.API_KEY && key !== 'mente-milionaria-2024') {
      return res.status(401).json({
        success: false,
        message: 'Acesso não autorizado',
        code: 'UNAUTHORIZED'
      });
    }

    // Estatísticas gerais
    const [
      total,
      hoje,
      semana,
      mes,
      statusStats,
      origemStats,
      utmStats
    ] = await Promise.all([
      // Total de leads
      prisma.lead.count(),
      
      // Leads de hoje
      prisma.lead.count({
        where: {
          dataCaptura: {
            gte: new Date(new Date().setHours(0, 0, 0, 0))
          }
        }
      }),
      
      // Leads da semana
      prisma.lead.count({
        where: {
          dataCaptura: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          }
        }
      }),
      
      // Leads do mês
      prisma.lead.count({
        where: {
          dataCaptura: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
          }
        }
      }),
      
      // Leads por status
      prisma.lead.groupBy({
        by: ['status'],
        _count: { status: true }
      }),
      
      // Leads por origem
      prisma.lead.groupBy({
        by: ['origem'],
        _count: { origem: true }
      }),
      
      // Leads por UTM Source
      prisma.lead.groupBy({
        by: ['utmSource'],
        _count: { utmSource: true },
        where: { utmSource: { not: null } }
      })
    ]);

    // Formatar dados para resposta
    const statusData = statusStats.reduce((acc, item) => {
      acc[item.status] = item._count.status;
      return acc;
    }, {});

    const origemData = origemStats.reduce((acc, item) => {
      acc[item.origem] = item._count.origem;
      return acc;
    }, {});

    const utmData = utmStats.reduce((acc, item) => {
      acc[item.utmSource] = item._count.utmSource;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        resumo: {
          total,
          hoje,
          semana,
          mes
        },
        porStatus: statusData,
        porOrigem: origemData,
        porUtmSource: utmData
      }
    });

  } catch (error) {
    console.error('❌ Erro ao buscar estatísticas:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Criar conversão
app.post('/api/leads/:leadId/conversao', async (req, res) => {
  try {
    const { leadId } = req.params;
    const { key } = req.query;
    const { tipo, valor, descricao } = req.body;
    
    if (key !== process.env.API_KEY && key !== 'mente-milionaria-2024') {
      return res.status(401).json({
        success: false,
        message: 'Acesso não autorizado',
        code: 'UNAUTHORIZED'
      });
    }

    const conversao = await prisma.conversao.create({
      data: {
        leadId,
        tipo,
        valor: valor ? parseFloat(valor) : null,
        descricao
      }
    });

    // Atualizar status do lead para convertido
    await prisma.lead.update({
      where: { id: leadId },
      data: { status: 'convertido' }
    });

    res.status(201).json({
      success: true,
      message: 'Conversão registrada com sucesso',
      data: conversao
    });

  } catch (error) {
    console.error('❌ Erro ao registrar conversão:', error);
    res.status(500).json({
      success: false,
      message: 'Erro interno do servidor',
      code: 'INTERNAL_ERROR'
    });
  }
});

// Middleware para rotas não encontradas
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint não encontrado',
    code: 'ENDPOINT_NOT_FOUND'
  });
});

process.on('SIGINT', async () => {
  console.log('🔄 Fechando conexão com banco...');
  await prisma.$disconnect();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 API Mente Milionária rodando na porta ${PORT}`);
  console.log(`📍 Health Check: http://localhost:${PORT}/health`);
  console.log(`📋 Capturar lead: POST http://localhost:${PORT}/api/leads`);
  console.log(`📊 Listar leads: GET http://localhost:${PORT}/api/leads?key=mente-milionaria-2024`);
  console.log(`📈 Estatísticas: GET http://localhost:${PORT}/api/stats?key=mente-milionaria-2024`);
  console.log(`💾 Banco: SQLite (leads.db)`);
});

export default app;
